FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY --chown=node:node server.js ./server.js
RUN install -d -o node -g node -m 0700 /data
ENV NODE_ENV=production DIRECT_XFER_OAUTH_BROKER_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 55810
USER node
CMD ["node", "server.js"]
