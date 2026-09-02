FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV PORT=9743 HOST=0.0.0.0
EXPOSE 9743
VOLUME /app/data
USER node
CMD ["node", "server.js"]
