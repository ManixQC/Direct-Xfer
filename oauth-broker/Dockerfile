FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node server.js ./server.js
RUN install -d -o node -g node -m 0700 /data
ENV NODE_ENV=production DIRECT_XFER_OAUTH_BROKER_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 55810
USER node
CMD ["node", "server.js"]
