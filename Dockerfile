FROM alpine:3.22
RUN apk add --no-cache nodejs && adduser -D -H app && mkdir -p /app/data && chown app:app /app/data
WORKDIR /app
COPY server.js .
ENV PORT=9743 HOST=0.0.0.0
EXPOSE 9743
VOLUME /app/data
USER app
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/api/pads" > /dev/null || exit 1
CMD ["node", "server.js"]
