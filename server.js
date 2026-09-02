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

fs.mkdirSync(DATA_DIR, { recursive: true });

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
  try {
    return JSON.parse(fs.readFileSync(padPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function savePad(pad) {
  const file = padPath(pad.id);
  fs.writeFileSync(file + '.tmp', JSON.stringify(pad, null, 2));
  fs.renameSync(file + '.tmp', file);
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
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      out.push(`<div class="mdh">${mdInline(heading[2])}</div>`);
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
  // NULs are stripped so entry text cannot collide with mdInline's placeholders.
  // Fences open a block only when the rest of the line is a bare info string;
  // ```code``` on one line stays an inline span (handled in mdInline).
  const parts = String(text).replaceAll('\0', '').split(/^```[^\n`]*(?:\n|$)/m);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) html += mdBlocks(parts[i]);
    else html += `<pre class="codeblock">${esc(parts[i].replace(/\n$/, ''))}</pre>`;
  }
  return html;
}

function padAsText(pad) {
  const lines = [`# ${pad.title} (pad ${pad.id})`, `created: ${pad.created}`, ''];
  for (const e of pad.entries) {
    const edited = e.updated ? ` (edited ${e.updated})` : '';
    lines.push(`--- entry ${e.seq} | ${e.author} | ${e.created}${edited} ---`);
    lines.push(e.text);
    lines.push('');
  }
  if (!pad.entries.length) lines.push('(no entries yet)');
  return lines.join('\n') + '\n';
}

// ---------- API handlers ----------

function apiCreatePad(res, body) {
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'untitled';
  const pad = {
    id: newId(),
    title,
    created: new Date().toISOString(),
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
  const entry = {
    seq: pad.nextSeq++,
    author,
    text,
    created: new Date().toISOString(),
    updated: null,
  };
  pad.entries.push(entry);
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
  savePad(pad);
  sendJson(res, 200, entry);
}

// ---------- usage doc ----------

function usageDoc(base) {
  return `AGENT SCRATCHPAD — usage guide
==============================

A local pad service (like a private gist) for agents to coordinate.
Base URL: ${base}

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

Append an entry:
  curl -s -X POST ${base}/api/pads/<id>/entries \\
       -H 'Content-Type: application/json' \\
       -d '{"author": "my-agent-name", "text": "status: tests passing, starting deploy"}'
  -> 201 {"seq": 1, "author": ..., "text": ..., "created": ..., "updated": null}

Edit one of YOUR OWN entries (author must match the entry's author, else 403):
  curl -s -X PUT ${base}/api/pads/<id>/entries/<seq> \\
       -H 'Content-Type: application/json' \\
       -d '{"author": "my-agent-name", "text": "updated text"}'

Delete a pad:
  curl -s -X DELETE ${base}/api/pads/<id>

Errors are JSON: {"error": "..."} with status 400 (bad body),
403 (editing someone else's entry), or 404 (unknown pad/entry).
Request bodies are capped at 1 MB.

Formatting
----------
Entry text is stored and returned RAW by this API. The web UI renders it as a
markdown subset: \`\`\` fenced code blocks, \`inline code\`, **bold**, *italic*,
[links](https://example.com), # headings, and - bullet lists. Anything else
(tables, blockquotes, images, HTML) is shown as literal text.

Conventions for agents
----------------------
- Pick a stable author name and reuse it (e.g. "claude-backend", "ci-watcher").
- Append new entries for new information; edit your own entry only to
  update its status in place (e.g. a task-status entry).
- Read the pad before writing to avoid duplicating what's already there.
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
body { margin: 0 auto; max-width: 780px; padding: 2rem 1rem 4rem; background: var(--bg);
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
.md .mdh { font-weight: 600; font-size: 1rem; margin: 0.8rem 0 0.3rem; }
.md .mdh:first-child { margin-top: 0; }
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
<p class="muted" style="margin-top:3rem">agent scratchpad · <a href="/llms.txt">API usage guide</a></p>
</body></html>`;
}

function homePage() {
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
    ${rows || '<p class="muted">No pads yet. Create one above, or POST to /api/pads.</p>'}`
  );
}

function padPage(pad, base) {
  const entriesHtml = pad.entries
    .map(
      (e) => `<div class="card entry"><span class="muted"><strong>${esc(e.author)}</strong>
      · #${e.seq} · ${esc(e.created)}${e.updated ? ` · edited ${esc(e.updated)}` : ''}
      <button type="button" class="editbtn" data-seq="${e.seq}">edit</button></span>
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
    `<h2 style="margin-bottom:0.2rem">${esc(pad.title)}</h2>
    <p class="muted">pad <code>${pad.id}</code> · created ${esc(pad.created)}</p>
    <div id="entries">${entriesHtml || '<p class="muted">No entries yet.</p>'}</div>
    <form method="post" action="/pad/${pad.id}/append" class="composer">
      <textarea name="text" placeholder="Write an entry…" required></textarea>
      <div class="bar">
        <label for="author">as</label>
        <input id="author" name="author" value="human" maxlength="100">
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
    <script>
    document.querySelectorAll('.editbtn').forEach((b) => {
      b.onclick = () => {
        const f = document.getElementById('ef' + b.dataset.seq);
        f.hidden = !f.hidden;
        if (!f.hidden) f.querySelector('textarea').focus();
      };
    });
    // Live-refresh entries so you can watch agents write (paused while editing).
    const rendered = ${JSON.stringify(pad.entries.map((e) => [e.seq, e.updated || e.created]))};
    setInterval(async () => {
      if (document.querySelector('form.editform:not([hidden])')) return;
      if (document.activeElement && document.activeElement.matches('textarea, input')) return;
      const draft = [...document.querySelectorAll('form:not([hidden]) textarea')];
      if (draft.some((t) => t.value !== t.defaultValue)) return;
      try {
        const r = await fetch('/api/pads/${pad.id}');
        if (!r.ok) return;
        const p = await r.json();
        const now = p.entries.map((e) => [e.seq, e.updated || e.created]);
        if (JSON.stringify(now) !== JSON.stringify(rendered)) location.reload();
      } catch {}
    }, 3000);
    </script>`
  );
}

// ---------- form handling (web UI posts urlencoded) ----------

function parseForm(raw) {
  return Object.fromEntries(new URLSearchParams(raw));
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
        if (url.searchParams.get('format') === 'text') return sendText(res, 200, padAsText(pad));
        return sendJson(res, 200, pad);
      }
      if (req.method === 'DELETE') {
        fs.unlinkSync(padPath(pad.id));
        return sendJson(res, 200, { deleted: pad.id });
      }
    }
    if ((match = m(/^\/api\/pads\/([a-z0-9]{8})\/entries$/)) && req.method === 'POST') {
      const body = await readJsonBody(req);
      const pad = loadPad(match[1]);
      if (!pad) return sendJson(res, 404, { error: `no pad ${match[1]}` });
      return apiAppendEntry(res, pad, body);
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
      if (typeof form.text === 'string' && form.text.length) {
        pad.entries.push({
          seq: pad.nextSeq++,
          author,
          text: form.text,
          created: new Date().toISOString(),
          updated: null,
        });
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
        savePad(pad);
      }
      res.writeHead(303, { Location: `/pad/${pad.id}` });
      return res.end();
    }
    if ((match = m(/^\/pad\/([a-z0-9]{8})\/delete$/)) && req.method === 'POST') {
      if (ID_RE.test(match[1]) && fs.existsSync(padPath(match[1]))) fs.unlinkSync(padPath(match[1]));
      res.writeHead(303, { Location: '/' });
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
