FROM node:22-alpine
WORKDIR /app
COPY server.js ./server.js
ENV NODE_ENV=production DIRECT_XFER_OAUTH_BROKER_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 55810
CMD ["node", "server.js"]
