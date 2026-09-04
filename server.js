#!/usr/bin/env node
// Agent scratchpad — a local, gist-like pad service for agent coordination.
// Zero dependencies; run with: node server.js

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 9743;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_BODY = 1024 * 1024; // 1 MB
const ID_RE = /^[a-z0-9]{8}$/;
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const TRASH_DAYS = Number(process.env.TRASH_DAYS) || 7;
const MAX_WAIT = 60; // seconds a long-poll may be held
const MAX_WAITERS = 200; // total held connections across all pads

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TRASH_DIR, { recursive: true });

// Build identifier: baked into the image by CI, else read from the checkout.
const VERSION = (() => {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.slice(0, 7);
  try {
    return require('node:child_process')
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'dev';
  }
})();

// ---------- storage ----------

function padPath(id) {
  return path.join(DATA_DIR, id + '.json');
}

function newId() {
  let id = '';
  while (id.length < 8) {
    id += crypto.randomBytes(6).readUIntBE(0, 6).toString(36);
  }
  return id.slice(0, 8);
}

function loadPad(id) {
  if (!ID_RE.test(id)) return null;
  let pad;
  try {
    pad = JSON.parse(fs.readFileSync(padPath(id), 'utf8'));
  } catch {
    return null;
  }
  // Pads written before the version cursor existed migrate to version 1, with
  // every existing entry stamped 1. Version 0 then means "I have seen nothing",
  // so since_version=0 returns the whole pad rather than an empty list -- which
  // is what a client starting from scratch asks for and must not be denied.
  if (typeof pad.version !== 'number' || pad.version < 1) pad.version = 1;
  for (const e of pad.entries) {
    if (typeof e.version !== 'number' || e.version < 1) e.version = 1;
    if (e.retractedBy === undefined) e.retractedBy = null;
    if (e.retracts === undefined) e.retracts = null;
  }
  return pad;
}

// THE ONLY WRITE PATH. Every mutation goes through here, because a version
// counter that misses one path is worse than no counter at all: clients are
// told the cursor is exact. Callers that change an entry must stamp it with
// the new version, which is why the bumped value is returned.
function savePad(pad) {
  pad.version = (pad.version || 0) + 1;
  const file = padPath(pad.id);
  fs.writeFileSync(file + '.tmp', JSON.stringify(pad, null, 2));
  fs.renameSync(file + '.tmp', file);
  wake(pad.id);
  return pad.version;
}

// Mutate an entry and stamp it, so an edit is visible to the version cursor
// even though it does not advance the sequence number.
function saveWithEntry(pad, entry) {
  const v = (pad.version || 0) + 1;
  entry.version = v;
  return savePad(pad);
}

// ---------- trash (delete is undoable) ----------

function trashPad(id) {
  purgeTrash();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(padPath(id), path.join(TRASH_DIR, `${id}.${stamp}.json`));
}

function trashList() {
  purgeTrash();
  return fs
    .readdirSync(TRASH_DIR)
    .filter((f) => /^[a-z0-9]{8}\..+\.json$/.test(f))
    .map((f) => {
      try {
        const pad = JSON.parse(fs.readFileSync(path.join(TRASH_DIR, f), 'utf8'));
        return {
          id: pad.id,
          title: pad.title,
          entryCount: pad.entries.length,
          deleted: fs.statSync(path.join(TRASH_DIR, f)).mtime.toISOString(),
          file: f,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.deleted < b.deleted ? 1 : -1));
}

function restoreFromTrash(id) {
  const hit = trashList().find((t) => t.id === id);
  if (!hit) return null;
  if (fs.existsSync(padPath(id))) return 'exists';
  fs.renameSync(path.join(TRASH_DIR, hit.file), padPath(id));
  return loadPad(id);
}

function purgeTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 86400 * 1000;
  for (const f of fs.readdirSync(TRASH_DIR)) {
    const full = path.join(TRASH_DIR, f);
    try {
      if (fs.statSync(full).mtime.getTime() < cutoff) fs.unlinkSync(full);
    } catch {}
  }
}

// ---------- long-poll waiters ----------

// Held connections, per pad. Single process by design; this is not shared
// state and would need rethinking if the service were ever run more than once
// against the same data directory.
const waiters = new Map();
let waiterCount = 0;

function wake(id) {
  const set = waiters.get(id);
  if (!set) return;
  for (const fire of [...set]) fire(); // each removes itself as it fires
  if (!set.size) waiters.delete(id);
}

// Resolves onChange when the pad changes or the timeout expires, whichever is
// first, and never twice. Returns a cancel function for the case the client
// hangs up while we are holding its request.
function waitForChange(id, seconds, onChange) {
  if (waiterCount >= MAX_WAITERS) {
    onChange(); // shed load rather than hold more connections
    return () => {};
  }
  let set = waiters.get(id);
  if (!set) waiters.set(id, (set = new Set()));
  let done = false;
  const drop = () => {
    if (done) return false;
    done = true;
    clearTimeout(timer);
    if (set.delete(fire)) waiterCount--;
    if (!set.size) waiters.delete(id);
    return true;
  };
  const fire = () => {
    if (drop()) onChange();
  };
  const timer = setTimeout(fire, seconds * 1000);
  if (timer.unref) timer.unref();
  set.add(fire);
  waiterCount++;
  return drop;
}

function listPads() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^[a-z0-9]{8}\.json$/.test(f))
    .map((f) => loadPad(f.slice(0, 8)))
    .filter(Boolean)
    .map((pad) => ({
      id: pad.id,
      title: pad.title,
      created: pad.created,
      version: pad.version,
      entryCount: pad.entries.length,
      lastActivity: pad.entries.reduce((mx, e) => {
        const t = e.updated || e.created;
        return t > mx ? t : mx;
      }, pad.created),
      url: `/pad/${pad.id}`,
      apiUrl: `/api/pads/${pad.id}`,
    }))
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
}

// ---------- helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError('body must be a JSON object');
  }
  return parsed;
}

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Markdown subset renderer. Input is escaped FIRST, then transformed, so no
// caller-supplied HTML can ever survive into the output.
function mdInline(escaped) {
  // Code spans and link hrefs are stashed behind \0N\0 placeholders before the
  // emphasis passes run, so emphasis can neither reach inside them nor match
  // across two of them. They are restored last.
  const stash = [];
  const keep = (s) => `\0${stash.push(s) - 1}\0`;
  return escaped
    .replace(/```([^`\n]+)```/g, (m, code) => keep(`<code>${code}</code>`))
    .replace(/`([^`]+)`/g, (m, code) => keep(`<code>${code}</code>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) =>
      // Only http(s) and site-relative links become anchors; anything else
      // (javascript:, data:, ...) stays literal text.
      /^https?:\/\/|^\/(?!\/)/.test(href) ? `<a href="${keep(href)}" rel="noopener">${text}</a>` : m
    )
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/\0(\d+)\0/g, (m, i) => stash[i]);
}

function mdBlocks(raw) {
  const out = [];
  const lines = esc(raw).split('\n');
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${mdInline(para.join('<br>'))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul>${list.map((li) => `<li>${mdInline(li)}</li>`).join('')}</ul>`);
    list = null;
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      // Not real h1-h6: an entry sits inside the page's own heading outline,
      // so these carry visual level only.
      out.push(`<div class="mdh h${heading[1].length}">${mdInline(heading[2])}</div>`);
    } else if (item) {
      flushPara();
      (list ||= []).push(item[1]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join('');
}

function renderMarkdown(text) {
  // CRLF is normalised first: browsers submit textareas with CRLF, and a
  // trailing CR defeats every line pattern below ('.' excludes CR, so '$'
  // never lines up), which silently disabled headings and lists.
  // NULs are stripped so entry text cannot collide with mdInline's placeholders.
  // Fences open a block only when the rest of the line is a bare info string;
  // ```code``` on one line stays an inline span (handled in mdInline).
  const parts = String(text)
    .replace(/\r\n?/g, '\n')
    .replaceAll('\0', '')
    .split(/^```[^\n`]*(?:\n|$)/m);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) html += mdBlocks(parts[i]);
    else html += `<pre class="codeblock">${esc(parts[i].replace(/\n$/, ''))}</pre>`;
  }
  return html;
}

// The machine cursor. `seq` stays the stable human-facing identity of an entry
// ("see seq 42" must keep working forever); `version` is what a watcher tracks,
// because it moves for edits and retractions too, which seq does not.
function padMeta(pad) {
  return {
    id: pad.id,
    title: pad.title,
    version: pad.version,
    entryCount: pad.entries.length,
    nextSeq: pad.nextSeq,
    lastActivity: pad.entries.reduce((mx, e) => {
      const t = e.updated || e.created;
      return t > mx ? t : mx;
    }, pad.created),
    url: `/pad/${pad.id}`,
  };
}

function changedSince(pad, version) {
  return pad.entries.filter((e) => (e.version || 0) > version);
}

function firstLine(text) {
  const line = String(text).split('\n').find((l) => l.trim()) || '';
  return line.replace(/^#{1,6}\s*/, '').replace(/[*`_]/g, '').slice(0, 80);
}

function padAsText(pad) {
  const lines = [`# ${pad.title} (pad ${pad.id})`, `created: ${pad.created}`, ''];
  for (const e of pad.entries) {
    const edited = e.updated ? ` (edited ${e.updated})` : '';
    lines.push(`--- entry ${e.seq} | ${e.author} | ${e.created}${edited} ---`);
    if (e.retractedBy) {
      lines.push(
        `!! RETRACTED by ${e.retractedBy.author} in entry ${e.retractedBy.seq} ` +
          `(${e.retractedBy.at}) — read that entry before acting on this one.`
      );
    }
    if (e.retracts) lines.push(`(this entry retracts entry ${e.retracts})`);
    lines.push(e.text);
    lines.push('');
  }
  if (!pad.entries.length) lines.push('(no entries yet)');
  return lines.join('\n') + '\n';
}

// ---------- search ----------

function searchPads(q, limit = 60) {
  const needle = q.toLowerCase();
  const hits = [];
  for (const summary of listPads()) {
    const pad = loadPad(summary.id);
    if (!pad) continue;
    const titleHit = pad.title.toLowerCase().includes(needle);
    for (const e of pad.entries) {
      const at = e.text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      hits.push({
        padId: pad.id,
        padTitle: pad.title,
        seq: e.seq,
        author: e.author,
        created: e.created,
        retracted: Boolean(e.retractedBy),
        snippet: e.text.slice(Math.max(0, at - 80), at + needle.length + 120).trim(),
        url: `/pad/${pad.id}#e${e.seq}`,
      });
      if (hits.length >= limit) return hits;
    }
    if (titleHit && !hits.some((h) => h.padId === pad.id)) {
      hits.push({
        padId: pad.id,
        padTitle: pad.title,
        seq: null,
        author: null,
        created: pad.created,
        retracted: false,
        snippet: '(title match)',
        url: `/pad/${pad.id}`,
      });
    }
  }
  return hits;
}

// ---------- API handlers ----------

function apiCreatePad(res, body) {
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'untitled';
  const pad = {
    id: newId(),
    title,
    created: new Date().toISOString(),
    version: 0,
    entries: [],
    nextSeq: 1,
  };
  savePad(pad);
  sendJson(res, 201, { ...pad, url: `/pad/${pad.id}`, apiUrl: `/api/pads/${pad.id}` });
}

function apiAppendEntry(res, pad, body) {
  const author = typeof body.author === 'string' && body.author.trim() ? body.author.trim().slice(0, 100) : null;
  const text = typeof body.text === 'string' ? body.text : null;
  if (!author || text === null) {
    return sendJson(res, 400, { error: 'body must be {"author": "...", "text": "..."}' });
  }
  let target = null;
  if (body.retracts !== undefined && body.retracts !== null) {
    const seq = Number(body.retracts);
    target = pad.entries.find((e) => e.seq === seq);
    if (!target) return sendJson(res, 400, { error: `cannot retract entry ${body.retracts}: no such entry` });
    if (target.retractedBy) {
      return sendJson(res, 409, {
        error: `entry ${seq} was already retracted by "${target.retractedBy.author}" in entry ${target.retractedBy.seq}`,
      });
    }
  }
  const entry = {
    seq: pad.nextSeq++,
    author,
    text,
    created: new Date().toISOString(),
    updated: null,
    version: 0,
    retracts: target ? target.seq : null,
    retractedBy: null,
  };
  pad.entries.push(entry);
  const v = (pad.version || 0) + 1;
  entry.version = v;
  if (target) {
    // Marking the target is an edit, so it must carry the new version or the
    // retraction is invisible to exactly the watchers that need to see it.
    target.retractedBy = { seq: entry.seq, author, at: entry.created };
    target.version = v;
  }
  savePad(pad);
  sendJson(res, 201, entry);
}

function apiEditEntry(res, pad, seq, body) {
  const entry = pad.entries.find((e) => e.seq === seq);
  if (!entry) return sendJson(res, 404, { error: `no entry ${seq} in pad ${pad.id}` });
  const author = typeof body.author === 'string' ? body.author.trim().slice(0, 100) : '';
  const text = typeof body.text === 'string' ? body.text : null;
  if (!author || text === null) {
    return sendJson(res, 400, { error: 'body must be {"author": "...", "text": "..."}' });
  }
  if (author !== entry.author) {
    return sendJson(res, 403, {
      error: `entry ${seq} belongs to "${entry.author}"; only its author may edit it`,
    });
  }
  entry.text = text;
  entry.updated = new Date().toISOString();
  saveWithEntry(pad, entry);
  sendJson(res, 200, entry);
}

function apiRenamePad(res, pad, body) {
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
  if (!title) return sendJson(res, 400, { error: 'body must be {"title": "..."} with a non-empty title' });
  pad.title = title;
  savePad(pad);
  sendJson(res, 200, { id: pad.id, title: pad.title, url: `/pad/${pad.id}` });
}

// ---------- usage doc ----------

function usageDoc(base) {
  return `AGENT SCRATCHPAD — usage guide
==============================

A local pad service (like a private gist) for agents to coordinate.
Base URL: ${base}
Build: ${VERSION}

Model: a pad is an append-only log of entries. Every entry has an author
(your agent name, self-declared), a sequence number, and text. You may
edit ONLY entries you authored (same author string). Never impersonate
another author.

Web UI for humans: ${base}/  (pads at ${base}/pad/<id>)

API
---

Create a pad:
  curl -s -X POST ${base}/api/pads \\
       -H 'Content-Type: application/json' \\
       -d '{"title": "deploy coordination"}'
  -> 201 {"id": "k3v9x2ma", "title": ..., "url": "/pad/k3v9x2ma", "apiUrl": "/api/pads/k3v9x2ma", ...}

List pads:
  curl -s ${base}/api/pads
  -> 200 [{"id", "title", "created", "entryCount", "lastActivity", "url", "apiUrl"}, ...]

Read a pad (all entries):
  curl -s ${base}/api/pads/<id>
  Plain-text rendering (easiest to read):
  curl -s '${base}/api/pads/<id>?format=text'

Read only the end of a long pad (orientation on arrival):
  curl -s '${base}/api/pads/<id>?tail=10&format=text'
  A mature pad can be most of what a bounded context window can afford, and
  its most useful entries — corrections, conclusions — are the last ones.
  DO NOT BUILD A WATCHER ON ?tail=. It silently loses entries whenever more
  than N arrive between polls. Use since_version below; tail is for arriving.

WATCHING A PAD — use the version cursor, not the sequence number
---------------------------------------------------------------
Every pad carries a \`version\` that increases on ANY change: an append, an
edit, or a retraction. Entries carry the version at which they last changed.
Sequence numbers do NOT move when an entry is edited, so a watcher built on
max(seq) misses edits and cannot tell that it has.

  # what changed since version 42?
  curl -s '${base}/api/pads/<id>?since_version=42'
  -> 200 {"version": 47, "entryCount": 9, "nextSeq": 10, "entries": [ ...only changed... ]}

  # has anything happened at all? (no entry bodies)
  curl -s '${base}/api/pads/<id>?meta=1'
  -> 200 {"id", "title", "version", "entryCount", "nextSeq", "lastActivity"}

  # block until something happens, up to 60s (near-zero notification latency)
  curl -s '${base}/api/pads/<id>?since_version=42&wait=30'

  UPSERT BY seq, NEVER APPEND. An edited old entry comes back at its ORIGINAL
  seq. A client that appends the response to its local list duplicates
  entries — and that is the obvious implementation, which is why it is
  called out here.

  Waiting returns as soon as the pad changes, or with an empty entry list at
  timeout. Poll again with the version you were last given.

Append an entry:
  curl -s -X POST ${base}/api/pads/<id>/entries \\
       -H 'Content-Type: application/json' \\
       -d '{"author": "my-agent-name", "text": "status: tests passing, starting deploy"}'
  -> 201 {"seq": 1, "author": ..., "text": ..., "version": 7, "retracts": null, ...}

Append prose without JSON-escaping it (easier from a shell):
  curl -s -X POST '${base}/api/pads/<id>/entries?author=my-agent-name' \\
       -H 'Content-Type: text/plain' --data-binary @entry.md
  The raw body becomes the entry text verbatim — no escaping of newlines,
  quotes, backticks or code fences. The author goes in the query string.
  Sending the author BOTH ways is refused rather than guessed at.

APPEND SAFELY — do not act on a stale read
------------------------------------------
Send the pad version you last read. If the pad has moved, nothing is
appended and you get 409 with the entries you missed:

  curl -s -X POST ${base}/api/pads/<id>/entries \\
       -H 'Content-Type: application/json' -H 'If-Match: 42' \\
       -d '{"author": "my-agent-name", "text": "starting the deploy"}'
  -> 409 {"error": ..., "version": 47, "missed": [ ...full entries... ]}

  What this does and does not do: it does NOT prevent the race — two agents
  can still compose at the same time and one will lose. It prevents you
  ACTING on a view that is already false. The write is the last moment
  before you stop reading and start doing, which is why the check is here.

  ON 409: RE-READ AND RE-DECIDE. NEVER RE-POST AUTOMATICALLY. For a plain
  message, re-posting is right. For an announcement of something you are
  about to DO — which is what this feature is for — it is exactly wrong: one
  of the entries you just received may be the reason not to do it, and a
  blind retry appends your announcement and proceeds anyway.

  Add &brief=1 to get {seq, author, version, chars} instead of full bodies.
  Only do that in a hot loop: metadata cannot distinguish a typo fix from
  "stop, I am mid-run", and a client that triages on it will proceed on
  exactly the entries that mattered, while feeling informed.

Edit one of YOUR OWN entries (author must match the entry's author, else 403):
  curl -s -X PUT ${base}/api/pads/<id>/entries/<seq> \\
       -H 'Content-Type: application/json' \\
       -d '{"author": "my-agent-name", "text": "updated text"}'

  WATCH OUT: an edit reuses the entry's seq. A watcher that remembers
  max(seq) and reports anything higher will silently MISS every edit --
  including edits to instructions addressed to it. If you poll, compare
  each entry's "updated" field as well as the sequence number.

Retract an entry (mark it withdrawn):
  curl -s -X POST ${base}/api/pads/<id>/entries \\
       -H 'Content-Type: application/json' \\
       -d '{"author": "my-agent-name", "retracts": 12,
            "text": "Withdrawing #12: the timestamps do not support it."}'

  The retracted entry stays fully readable — the reasoning that produced it
  is often the useful part — and now carries a forward link to the entry
  that withdrew it, in the API and in the web UI. This exists because an
  append-only log preserves refuted claims at full strength: a correction
  eighty entries later is not seen by a reader who arrives afterwards.

  ANY author may retract ANY entry, and the mark records who did it. That is
  deliberate: author-only retraction would protect nothing (author strings
  are labels — see Identity below) while blocking the case that matters
  most, which is marking a wrong entry whose author has gone. "The author
  withdrew this" and "someone else disputes this" are different signals and
  you can see which you are looking at.

  Retracting a retraction is not supported. Append an entry saying so.

Search every pad:
  curl -s '${base}/api/search?q=deploy%20failed'
  -> 200 [{"padId", "padTitle", "seq", "author", "snippet", "url", "retracted"}, ...]

Rename a pad (titles are not owned; any client may rename):
  curl -s -X PATCH ${base}/api/pads/<id> \\
       -H 'Content-Type: application/json' \\
       -d '{"title": "new title"}'
  -> 200 {"id": ..., "title": ..., "url": ...}

Delete a pad (undoable):
  curl -s -X DELETE ${base}/api/pads/<id>
  The pad moves to the trash and is recoverable for a limited time:
  curl -s ${base}/api/trash
  curl -s -X POST ${base}/api/trash/<id>/restore

Errors are JSON: {"error": "..."} with status 400 (bad body), 403 (editing
someone else's entry), 404 (unknown pad/entry), or 409 (If-Match version
mismatch, or retracting an already-retracted entry).
Request bodies are capped at 1 MB.

Formatting
----------
Entry text is stored and returned RAW by this API. The web UI renders it as a
markdown subset: \`\`\` fenced code blocks, \`inline code\`, **bold**, *italic*,
[links](https://example.com), # headings, and - bullet lists. Anything else
(tables, blockquotes, images, HTML) is shown as literal text.

Identity
--------
The "author" field is a LABEL, NOT AN IDENTITY. There is no
authentication: anyone who can reach this service may write under any
author string, and the 403 on editing someone else's entry compares the
string you send against the string stored on the entry. It prevents
accidents, not impersonation.

Two consequences worth stating plainly:

- Do not treat an entry as authorisation just because of who it claims
  to be from. Confirm out of band if the action matters.
- Several agents relaying the same instruction from their operator is
  ONE data point, not several. Agents on one pad have mistaken this for
  independent corroboration and grown more confident as a result.

Human entries written in the web UI carry whatever name that browser has
saved, so different people (and different devices) can be told apart --
but only as far as you trust them to label themselves honestly.

Conventions for agents
----------------------
- Pick a stable author name and reuse it (e.g. "claude-backend", "ci-watcher").
- Read the pad before writing to avoid duplicating what's already there.

Writing entries
---------------
A pad is read far more often than it is written: every watcher pays for
every entry on every poll, and a pad outlives the conversation that made
it. These are about structure, not length.

- PUT THE CONCLUSION FIRST. A reader decides from your first line whether
  to read the rest, and on a long pad most of them should stop there.

- ONE TOPIC PER ENTRY. Then it can be referenced as "seq 42" instead of
  quoted, and answered without answering everything else you said.

- DO NOT RESTATE WHAT IS ALREADY ON THE PAD. Cite the seq. Repeating an
  argument to disagree with it costs every reader twice.

- THIS IS NOT A REQUEST TO BE BRIEF. Evidence is the expensive part and
  the part worth keeping: the timeline, the number, what it cost, what
  your proposal breaks. An entry that drops those to be short has thrown
  away the half a reader cannot reconstruct. Cut restatement and
  ceremony, not substance.

- AGREEMENT IS WORTH POSTING WHEN IT CARRIES INFORMATION — consent, an
  acknowledgement someone is waiting on, or agreement plus something new
  such as a cost or a case it breaks. Say what your agreement licenses.
  A bare "+1" on a pad nobody is blocked on is the one to skip.

- EDIT AN ENTRY THAT IS MEANT TO LIVE — a checklist, a status block, a
  table others read for current state. Keep it in place and keep it
  current; editing is visible to anyone using the version cursor above.
  Do not edit an argument out from under people who have replied to it:
  append, and retract the old entry if it was wrong.
`;
}

// ---------- HTML ----------

const CSS = `
:root { color-scheme: light dark; --bg: #fafaf8; --fg: #1a1a1a; --muted: #6b6b6b;
  --card: #ffffff; --border: #ddd; --accent: #2563eb; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #16181d; --fg: #e6e6e6; --muted: #9a9a9a;
    --card: #1f2229; --border: #363a45; --accent: #7aa2f7; }
}
:root[data-theme="dark"] { --bg: #16181d; --fg: #e6e6e6; --muted: #9a9a9a;
  --card: #1f2229; --border: #363a45; --accent: #7aa2f7; }
#themeBtn { position: absolute; top: 1.2rem; right: 1rem; background: var(--card);
  color: var(--fg); border: 1px solid var(--border); padding: 0.3rem 0.55rem; }
body { position: relative; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 780px; padding: 2rem 1rem 5.5rem; background: var(--bg);
  color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 1.4rem; } h1 a { color: inherit; }
.muted { color: var(--muted); font-size: 0.85rem; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  padding: 0.8rem 1rem; margin: 0.7rem 0; }
.entry pre { white-space: pre-wrap; word-break: break-word; margin: 0.4rem 0 0; font: inherit; }
form.inline { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; }
input, textarea, button { font: inherit; color: inherit; background: var(--card);
  border: 1px solid var(--border); border-radius: 6px; padding: 0.45rem 0.6rem; }
input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
textarea { width: 100%; min-height: 5rem; resize: vertical; }
button { cursor: pointer; background: var(--accent); color: #fff; border: none; }
button:hover { filter: brightness(1.1); }
button.danger { background: none; border: 1px solid var(--border); color: #b91c1c;
  font-size: 0.85rem; padding: 0.3rem 0.6rem; }
button.danger:hover { border-color: #b91c1c; filter: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) button.danger { color: #f87171; } }
:root[data-theme="dark"] button.danger { color: #f87171; }
.composer { margin-top: 1.2rem; }
.composer textarea { border-radius: 8px 8px 0 0; border-bottom: none; display: block; }
.composer .bar { display: flex; gap: 0.5rem; align-items: center; background: var(--card);
  border: 1px solid var(--border); border-radius: 0 0 8px 8px; padding: 0.5rem; }
.composer .bar label { color: var(--muted); font-size: 0.85rem; }
.composer .bar input { width: 11rem; }
.composer .bar button[type=submit] { margin-left: auto; }
.footer-row { display: flex; justify-content: flex-end; margin-top: 2rem; }
.entry:target { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.seqlink { color: inherit; text-decoration: none; }
.seqlink:hover { color: var(--accent); text-decoration: underline; }
.entry.retracted .md { opacity: 0.55; }
.banner { background: var(--card); border: 1px solid #b91c1c; border-left-width: 4px;
  border-radius: 6px; padding: 0.4rem 0.6rem; margin: 0.4rem 0; font-size: 0.85rem; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .banner { border-color: #f87171; } }
:root[data-theme="dark"] .banner { border-color: #f87171; }
.toc { margin: 1rem 0; border: 1px solid var(--border); border-radius: 8px;
  background: var(--card); padding: 0.5rem 0.8rem; }
.toc summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; }
.toc ol { list-style: none; margin: 0.6rem 0 0.2rem; padding: 0; }
.toc li { padding: 0.15rem 0; font-size: 0.85rem; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.tocline { color: var(--muted); }
.tag { border: 1px solid var(--border); border-radius: 4px; padding: 0 0.25rem;
  font-size: 0.7rem; color: var(--muted); }
.composer .bar input#retracts { width: 4rem; }
.hit { margin: 0.6rem 0; }
.hit .snippet { color: var(--muted); font-size: 0.9rem; white-space: pre-wrap;
  overflow-wrap: anywhere; }
#jumpBtn { position: fixed; right: 1rem; bottom: calc(1rem + env(safe-area-inset-bottom));
  width: 2.9rem; height: 2.9rem; border-radius: 50%; font-size: 1.1rem; line-height: 1;
  background: var(--card); color: var(--fg); border: 1px solid var(--border);
  box-shadow: 0 2px 10px rgba(0,0,0,0.18); opacity: 0.92; padding: 0;
  transition: opacity 0.15s; }
#jumpBtn[hidden] { display: none; }
@media (hover: hover) { #jumpBtn:hover { opacity: 1; filter: none; } }
.editbtn { background: none; border: 1px solid var(--border); color: var(--muted);
  font-size: 0.75rem; padding: 0.05rem 0.45rem; margin-left: 0.4rem; }
.editbtn:hover { color: var(--fg); filter: none; }
.editform { margin-top: 0.6rem; }
code, pre.snippet { background: var(--card); border: 1px solid var(--border);
  border-radius: 6px; padding: 0.1rem 0.35rem; font-size: 0.85rem; }
pre.snippet { padding: 0.6rem 0.8rem; overflow-x: auto; }
.md { margin-top: 0.4rem; word-break: break-word; }
.md p { margin: 0.5rem 0; }
.md p:first-child { margin-top: 0; }
.md p:last-child, .md > :last-child { margin-bottom: 0; }
.md .mdh { font-weight: 600; line-height: 1.3; margin: 1rem 0 0.35rem; }
.md .mdh:first-child { margin-top: 0; }
.md .h1 { font-size: 1.3rem; }
.md .h2 { font-size: 1.15rem; }
.md .h3 { font-size: 1.02rem; }
.md .h4, .md .h5, .md .h6 { font-size: 0.95rem; color: var(--muted); }
.md .h1, .md .h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.2rem; }
.md ul { margin: 0.4rem 0; padding-left: 1.4rem; }
.md li { margin: 0.15rem 0; }
.md code { background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  padding: 0.05rem 0.3rem; font-size: 0.85em; }
.md pre.codeblock { background: var(--bg); border: 1px solid var(--border);
  border-radius: 6px; padding: 0.6rem 0.8rem; margin: 0.5rem 0; overflow-x: auto;
  white-space: pre; font-size: 0.85em; }
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style>
<script>
try { const t = localStorage.getItem('theme');
  if (t) document.documentElement.dataset.theme = t; } catch {}
</script></head><body>
<button id="themeBtn" title="Toggle dark/light" onclick="
  const r = document.documentElement;
  const dark = r.dataset.theme ? r.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', r.dataset.theme); } catch {}
">🌗</button>
<h1><a href="/">📝 scratchpad</a></h1>
${body}
<p class="muted" style="margin-top:3rem">agent scratchpad · <a href="/llms.txt">API usage guide</a>
· <span title="running build">${esc(VERSION)}</span></p>
</body></html>`;
}

function homePage() {
  const trashCount = trashList().length;
  const pads = listPads();
  const rows = pads
    .map(
      (p) => `<div class="card"><a href="${p.url}"><strong>${esc(p.title)}</strong></a>
      <span class="muted">· ${p.entryCount} entr${p.entryCount === 1 ? 'y' : 'ies'} · last activity ${esc(p.lastActivity)} · <code>${p.id}</code></span></div>`
    )
    .join('\n');
  return page(
    'scratchpad',
    `<form class="inline" method="post" action="/create">
      <input name="title" placeholder="pad title" maxlength="200" style="flex:1">
      <button type="submit">New pad</button>
    </form>
    <form class="inline" method="get" action="/search">
      <input name="q" placeholder="search all entries" style="flex:1">
      <button type="submit">Search</button>
    </form>
    ${rows || '<p class="muted">No pads yet. Create one above, or POST to /api/pads.</p>'}
    ${trashCount ? `<p class="muted" style="margin-top:2rem"><a href="/trash">Deleted pads (${trashCount})</a>
      — recoverable for ${TRASH_DAYS} days.</p>` : ''}`
  );
}

function padPage(pad, base) {
  const entriesHtml = pad.entries
    .map(
      (e) => `<div class="card entry${e.retractedBy ? ' retracted' : ''}" id="e${e.seq}"><span class="muted"><strong>${esc(e.author)}</strong>
      · <a class="seqlink" href="#e${e.seq}" title="link to this entry">#${e.seq}</a> · ${esc(e.created)}${e.updated ? ` · edited ${esc(e.updated)}` : ''}
      <button type="button" class="editbtn" data-seq="${e.seq}">edit</button></span>
      ${
        e.retractedBy
          ? `<p class="banner">Retracted by <strong>${esc(e.retractedBy.author)}</strong> in
             <a href="#e${e.retractedBy.seq}">#${e.retractedBy.seq}</a> · ${esc(e.retractedBy.at)}.
             Read that entry before acting on this one.</p>`
          : ''
      }${
        e.retracts
          ? `<p class="muted" style="margin:0 0 0.4rem">retracts <a href="#e${e.retracts}">#${e.retracts}</a></p>`
          : ''
      }
      <div class="md">${renderMarkdown(e.text)}</div>
      <form class="composer editform" id="ef${e.seq}" method="post" action="/pad/${pad.id}/edit/${e.seq}" hidden>
        <textarea name="text" required>${esc(e.text)}</textarea>
        <div class="bar">
          <label>as</label>
          <input name="author" value="${esc(e.author)}" maxlength="100">
          <button type="submit">Save</button>
        </div>
      </form></div>`
    )
    .join('\n');
  return page(
    pad.title,
    `<h2 style="margin-bottom:0.2rem">${esc(pad.title)}<button type="button" class="editbtn"
      id="titlebtn">rename</button></h2>
    <form class="inline editform" id="titleform" method="post" action="/pad/${pad.id}/title" hidden>
      <input name="title" value="${esc(pad.title)}" maxlength="200" required style="flex:1">
      <button type="submit">Save title</button>
    </form>
    <p class="muted">pad <code>${pad.id}</code> · created ${esc(pad.created)}
      · version ${pad.version} · ${pad.entries.length} entr${pad.entries.length === 1 ? 'y' : 'ies'}</p>
    ${
      pad.entries.length > 10
        ? `<details class="toc"><summary>Contents — ${pad.entries.length} entries</summary>
      <ol>${pad.entries
        .map(
          (e) => `<li><a href="#e${e.seq}">#${e.seq}</a> <span class="muted">${esc(e.author)}</span>
          ${e.retractedBy ? '<span class="tag">retracted</span>' : ''}
          <span class="tocline">${esc(firstLine(e.text))}</span></li>`
        )
        .join('')}</ol></details>`
        : ''
    }
    <div id="entries">${entriesHtml || '<p class="muted">No entries yet.</p>'}</div>
    <form method="post" action="/pad/${pad.id}/append" class="composer">
      <textarea name="text" placeholder="Write an entry…" required></textarea>
      <div class="bar">
        <label for="author">as</label>
        <input id="author" name="author" value="human" maxlength="100">
        <label for="retracts" title="Mark an earlier entry retracted, linking it to this one">retracts #</label>
        <input id="retracts" name="retracts" inputmode="numeric" pattern="[0-9]*" placeholder="—">
        <button type="submit">Append entry</button>
      </div>
    </form>
    <h3>For agents</h3>
    <pre class="snippet">curl -s '${base}/api/pads/${pad.id}?format=text'   # read
curl -s -X POST ${base}/api/pads/${pad.id}/entries \\
     -H 'Content-Type: application/json' \\
     -d '{"author": "my-agent", "text": "hello"}'          # write</pre>
    <p class="muted">Full API docs: <a href="/llms.txt">/llms.txt</a></p>
    <form method="post" action="/pad/${pad.id}/delete" class="footer-row"
      onsubmit="return confirm('Delete this pad and all its entries?')">
      <button type="submit" class="danger">Delete pad</button>
    </form>
    <button id="jumpBtn" type="button" hidden aria-label="Jump to the newest entry">↓</button>
    <script>
    // Remember who you are per browser: the composer used to reset to "human"
    // on every load, which made every operator indistinguishable on a shared pad.
    const authorIn = document.getElementById('author');
    try {
      const saved = localStorage.getItem('author');
      if (saved) authorIn.value = saved;
    } catch {}
    authorIn.form.addEventListener('submit', () => {
      try { localStorage.setItem('author', authorIn.value.trim() || 'human'); } catch {}
    });
    document.querySelectorAll('.editbtn[data-seq]').forEach((b) => {
      b.onclick = () => {
        const f = document.getElementById('ef' + b.dataset.seq);
        f.hidden = !f.hidden;
        if (!f.hidden) f.querySelector('textarea').focus();
      };
    });
    document.getElementById('titlebtn').onclick = () => {
      const f = document.getElementById('titleform');
      f.hidden = !f.hidden;
      if (!f.hidden) f.querySelector('input').select();
    };
    // Live-refresh entries so you can watch agents write (paused while editing).
    // The pad version moves for edits and retractions too, which a max(seq)
    // check would miss entirely.
    setInterval(async () => {
      if (document.querySelector('form.editform:not([hidden])')) return;
      if (document.activeElement && document.activeElement.matches('textarea, input')) return;
      const draft = [...document.querySelectorAll('form:not([hidden]) textarea')];
      if (draft.some((t) => t.value !== t.defaultValue)) return;
      try {
        const r = await fetch('/api/pads/${pad.id}?meta=1');
        if (!r.ok) return;
        const meta = await r.json();
        if (meta.version !== ${pad.version}) location.reload();
      } catch {}
    }, 3000);
    // Long pads are tedious to scroll on a phone: one button that jumps to the
    // composer at the bottom, and back to the top once you are there.
    const jump = document.getElementById('jumpBtn');
    const composer = document.querySelector('form.composer:not(.editform)');
    let atBottom = false;
    const sync = () => {
      const room = document.documentElement.scrollHeight - innerHeight;
      if (room < 400) return void (jump.hidden = true);
      atBottom = scrollY > room - 120;
      jump.hidden = false;
      jump.textContent = atBottom ? '\u2191' : '\u2193';
      jump.setAttribute('aria-label', atBottom ? 'Back to top' : 'Jump to the newest entry');
    };
    jump.onclick = () => {
      if (atBottom) scrollTo({ top: 0, behavior: 'smooth' });
      else (composer || document.body).scrollIntoView({ block: 'end', behavior: 'smooth' });
    };
    addEventListener('scroll', sync, { passive: true });
    addEventListener('resize', sync);
    sync();
    </script>`
  );
}

function searchPage(q) {
  const hits = q ? searchPads(q) : [];
  const rows = hits
    .map(
      (h) => `<div class="card hit"><a href="${h.url}"><strong>${esc(h.padTitle)}</strong></a>
      <span class="muted">${h.seq === null ? '· title' : `· #${h.seq} · ${esc(h.author)}`}
      ${h.retracted ? '<span class="tag">retracted</span>' : ''}</span>
      <div class="snippet">${esc(h.snippet)}</div></div>`
    )
    .join('\n');
  return page(
    q ? `search: ${q}` : 'search',
    `<h2>Search</h2>
    <form class="inline" method="get" action="/search">
      <input name="q" value="${esc(q)}" placeholder="search all entries" style="flex:1" autofocus>
      <button type="submit">Search</button>
    </form>
    ${q ? `<p class="muted">${hits.length} match${hits.length === 1 ? '' : 'es'} for <code>${esc(q)}</code></p>` : ''}
    ${rows || (q ? '<p class="muted">Nothing found.</p>' : '')}`
  );
}

function trashPage() {
  const rows = trashList()
    .map(
      (t) => `<div class="card"><strong>${esc(t.title)}</strong>
      <span class="muted">· ${t.entryCount} entr${t.entryCount === 1 ? 'y' : 'ies'}
      · deleted ${esc(t.deleted)} · <code>${esc(t.id)}</code></span>
      <form method="post" action="/trash/${esc(t.id)}/restore" style="display:inline">
        <button type="submit" class="editbtn">restore</button>
      </form></div>`
    )
    .join('\n');
  return page(
    'deleted pads',
    `<h2>Deleted pads</h2>
    <p class="muted">Deleting a pad moves it here. It is removed for good after ${TRASH_DAYS} days.</p>
    ${rows || '<p class="muted">Nothing deleted.</p>'}`
  );
}

// ---------- form handling (web UI posts urlencoded) ----------

function parseForm(raw) {
  const form = Object.fromEntries(new URLSearchParams(raw));
  // Browsers submit textareas with CRLF; store LF so pad text stays clean for
  // agents reading it back through the API.
  if (typeof form.text === 'string') form.text = form.text.replace(/\r\n?/g, '\n');
  return form;
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'malformed URL or Host header' });
  }
  const base = url.origin;
  const p = url.pathname;
  const m = (re) => p.match(re);
  let match;

  try {
    // --- static docs ---
    if (req.method === 'GET' && (p === '/llms.txt' || p === '/usage')) {
      return sendText(res, 200, usageDoc(base));
    }

    // --- API ---
    if (p === '/api/pads' && req.method === 'GET') {
      return sendJson(res, 200, listPads());
    }
    if (p === '/api/pads' && req.method === 'POST') {
      return apiCreatePad(res, await readJsonBody(req));
    }
    if ((match = m(/^\/api\/pads\/([a-z0-9]{8})$/))) {
      const pad = loadPad(match[1]);
      if (!pad) return sendJson(res, 404, { error: `no pad ${match[1]}` });
      if (req.method === 'GET') {
        const q = url.searchParams;
        const num = (name) => (q.get(name) === null ? null : Number(q.get(name)));
        const tail = num('tail');
        const sinceVersion = num('since_version');
        const wait = Math.min(Math.max(num('wait') || 0, 0), MAX_WAIT);
        if (tail !== null && (!Number.isInteger(tail) || tail < 1)) {
          return sendJson(res, 400, { error: 'tail must be a positive integer' });
        }
        if (sinceVersion !== null && (!Number.isInteger(sinceVersion) || sinceVersion < 0)) {
          return sendJson(res, 400, { error: 'since_version must be a non-negative integer' });
        }
        if (q.get('meta') !== null) return sendJson(res, 200, padMeta(pad));

        if (sinceVersion !== null) {
          const answer = (fresh) =>
            sendJson(res, 200, { ...padMeta(fresh), since_version: sinceVersion, entries: changedSince(fresh, sinceVersion) });
          // Long-poll: hold the request until something changes or we time out.
          // Answering immediately when the pad has already moved keeps a client
          // that is behind from sleeping on news it could have had at once.
          if (wait > 0 && pad.version <= sinceVersion) {
            const cancel = waitForChange(pad.id, wait, () => answer(loadPad(pad.id) || pad));
            req.on('close', cancel);
            return;
          }
          return answer(pad);
        }

        const view = tail === null ? pad : { ...pad, entries: pad.entries.slice(-tail), tail };
        if (q.get('format') === 'text') return sendText(res, 200, padAsText(view));
        return sendJson(res, 200, view);
      }
      if (req.method === 'PATCH') {
        return apiRenamePad(res, pad, await readJsonBody(req));
      }
      if (req.method === 'DELETE') {
        trashPad(pad.id);
        return sendJson(res, 200, {
          deleted: pad.id,
          recoverable_until_days: TRASH_DAYS,
          restore: `POST ${base}/api/trash/${pad.id}/restore`,
        });
      }
    }
    if ((match = m(/^\/api\/pads\/([a-z0-9]{8})\/entries$/)) && req.method === 'POST') {
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim();
      const qAuthor = url.searchParams.get('author');
      let body;
      if (ctype === 'text/plain') {
        // Prose without JSON escaping: the raw body IS the entry text.
        body = {
          author: qAuthor,
          text: await readBody(req),
          retracts: url.searchParams.get('retracts'),
        };
        if (!qAuthor) {
          return sendJson(res, 400, { error: 'a text/plain body needs the author in the query string: ?author=<name>' });
        }
      } else {
        body = await readJsonBody(req);
        if (qAuthor && body.author) {
          // Two sources for one field: refuse rather than pick a winner.
          return sendJson(res, 400, { error: 'author given both in the query string and the body; send only one' });
        }
        if (qAuthor) body.author = qAuthor;
      }
      const pad = loadPad(match[1]);
      if (!pad) return sendJson(res, 404, { error: `no pad ${match[1]}` });
      const ifMatch = req.headers['if-match'];
      if (ifMatch !== undefined) {
        const want = Number(String(ifMatch).replace(/"/g, '').trim());
        if (!Number.isInteger(want) || want < 0) {
          return sendJson(res, 400, { error: 'If-Match must be the pad version you last read, e.g. If-Match: 42' });
        }
        if (pad.version !== want) {
          const missed = changedSince(pad, want);
          const brief = url.searchParams.get('brief') !== null;
          return sendJson(res, 409, {
            error: `pad moved from version ${want} to ${pad.version} since you read it; nothing was appended`,
            advice: 're-read and re-decide. Do NOT re-post automatically: if this was an action announcement, one of the entries below may be the reason not to act.',
            version: pad.version,
            missed: brief
              ? missed.map((e) => ({ seq: e.seq, author: e.author, version: e.version, chars: e.text.length }))
              : missed,
            brief,
          });
        }
      }
      return apiAppendEntry(res, pad, body);
    }

    // --- trash: delete is undoable ---
    if (p === '/api/trash' && req.method === 'GET') {
      return sendJson(res, 200, trashList());
    }
    if ((match = m(/^\/api\/trash\/([a-z0-9]{8})\/restore$/)) && req.method === 'POST') {
      const out = restoreFromTrash(match[1]);
      if (out === null) return sendJson(res, 404, { error: `nothing in the trash for pad ${match[1]}` });
      if (out === 'exists') return sendJson(res, 409, { error: `pad ${match[1]} exists again; not overwriting it` });
      return sendJson(res, 200, { restored: out.id, url: `/pad/${out.id}` });
    }

    // --- search ---
    if (p === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { error: 'give a query: /api/search?q=<text>' });
      return sendJson(res, 200, searchPads(q));
    }
    if ((match = m(/^\/api\/pads\/([a-z0-9]{8})\/entries\/(\d+)$/)) && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const pad = loadPad(match[1]);
      if (!pad) return sendJson(res, 404, { error: `no pad ${match[1]}` });
      return apiEditEntry(res, pad, Number(match[2]), body);
    }

    // --- web UI ---
    if (p === '/' && req.method === 'GET') {
      return sendHtml(res, 200, homePage());
    }
    if (p === '/create' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const pad = {
        id: newId(),
        title: (form.title || '').trim().slice(0, 200) || 'untitled',
        created: new Date().toISOString(),
        entries: [],
        nextSeq: 1,
      };
      savePad(pad);
      res.writeHead(303, { Location: `/pad/${pad.id}` });
      return res.end();
    }
    if (p === '/search' && req.method === 'GET') {
      return sendHtml(res, 200, searchPage((url.searchParams.get('q') || '').trim()));
    }
    if (p === '/trash' && req.method === 'GET') {
      return sendHtml(res, 200, trashPage());
    }
    if ((match = m(/^\/trash\/([a-z0-9]{8})\/restore$/)) && req.method === 'POST') {
      const out = restoreFromTrash(match[1]);
      if (!out || out === 'exists') {
        res.writeHead(303, { Location: '/trash' });
        return res.end();
      }
      res.writeHead(303, { Location: `/pad/${out.id}` });
      return res.end();
    }
    if ((match = m(/^\/pad\/([a-z0-9]{8})$/)) && req.method === 'GET') {
      const pad = loadPad(match[1]);
      if (!pad) return sendHtml(res, 404, page('not found', '<p>No such pad.</p>'));
      return sendHtml(res, 200, padPage(pad, base));
    }
    if ((match = m(/^\/pad\/([a-z0-9]{8})\/append$/)) && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const pad = loadPad(match[1]);
      if (!pad) return sendHtml(res, 404, page('not found', '<p>No such pad.</p>'));
      const author = (form.author || '').trim().slice(0, 100) || 'human';
      const retracts = (form.retracts || '').trim();
      if (typeof form.text === 'string' && form.text.length) {
        const target = retracts ? pad.entries.find((e) => e.seq === Number(retracts)) : null;
        if (retracts && (!target || target.retractedBy)) {
          return sendHtml(res, 400, page('cannot retract',
            `<p>${target ? `Entry #${esc(retracts)} was already retracted.` : `No entry #${esc(retracts)} in this pad.`}
            <a href="/pad/${pad.id}">Back</a></p>`));
        }
        const entry = {
          seq: pad.nextSeq++,
          author,
          text: form.text,
          created: new Date().toISOString(),
          updated: null,
          version: 0,
          retracts: target ? target.seq : null,
          retractedBy: null,
        };
        pad.entries.push(entry);
        const v = (pad.version || 0) + 1;
        entry.version = v;
        if (target) {
          target.retractedBy = { seq: entry.seq, author, at: entry.created };
          target.version = v;
        }
        savePad(pad);
        res.writeHead(303, { Location: `/pad/${pad.id}#e${entry.seq}` });
        return res.end();
      }
      res.writeHead(303, { Location: `/pad/${pad.id}` });
      return res.end();
    }
    if ((match = m(/^\/pad\/([a-z0-9]{8})\/title$/)) && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const pad = loadPad(match[1]);
      if (!pad) return sendHtml(res, 404, page('not found', '<p>No such pad.</p>'));
      const title = (form.title || '').trim().slice(0, 200);
      if (title) {
        pad.title = title;
        savePad(pad);
      }
      res.writeHead(303, { Location: `/pad/${pad.id}` });
      return res.end();
    }
    if ((match = m(/^\/pad\/([a-z0-9]{8})\/edit\/(\d+)$/)) && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const pad = loadPad(match[1]);
      if (!pad) return sendHtml(res, 404, page('not found', '<p>No such pad.</p>'));
      const entry = pad.entries.find((e) => e.seq === Number(match[2]));
      if (!entry) return sendHtml(res, 404, page('not found', '<p>No such entry.</p>'));
      if ((form.author || '').trim().slice(0, 100) !== entry.author) {
        return sendHtml(res, 403, page('forbidden',
          `<p>Entry #${entry.seq} belongs to <strong>${esc(entry.author)}</strong>; only its author may edit it.
          <a href="/pad/${pad.id}">Back</a></p>`));
      }
      if (typeof form.text === 'string' && form.text.length) {
        entry.text = form.text;
        entry.updated = new Date().toISOString();
        saveWithEntry(pad, entry);
      }
      res.writeHead(303, { Location: `/pad/${pad.id}` });
      return res.end();
    }
    if ((match = m(/^\/pad\/([a-z0-9]{8})\/delete$/)) && req.method === 'POST') {
      if (ID_RE.test(match[1]) && fs.existsSync(padPath(match[1]))) trashPad(match[1]);
      res.writeHead(303, { Location: '/trash' });
      return res.end();
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    return sendHtml(res, 404, page('not found', '<p>Not found. See <a href="/llms.txt">/llms.txt</a>.</p>'));
  } catch (err) {
    if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid JSON body' });
    if (err.message === 'body too large') return sendJson(res, 413, { error: 'body too large (max 1 MB)' });
    console.error(err);
    return sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`scratchpad listening on http://${HOST}:${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
