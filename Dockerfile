FROM node:22-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS server-dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server

FROM server-dev AS server-build
COPY server/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data WEB_DIST=/app/web/dist
WORKDIR /app
# The base image already provides the non-root node user (uid/gid 1000).
RUN mkdir -p /data && chown node:node /data
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=server-build /app/server/node_modules ./server/node_modules
COPY --from=server-build /app/server/package.json ./server/package.json
COPY --from=web-build /app/web/dist ./web/dist
EXPOSE 3000 1455
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "server/dist/index.js"]
