FROM alpine:3.22
RUN apk add --no-cache nodejs && adduser -D -H app && mkdir -p /app/data && chown app:app /app/data
WORKDIR /app
COPY server.js .
ENV PORT=9743 HOST=0.0.0.0
EXPOSE 9743
VOLUME /app/data
USER app
CMD ["node", "server.js"]
