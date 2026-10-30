# API, worker, migrations and demo seed share one image; the compose file picks the command.
# Build from the repository root:  docker build -f api/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace=api --include-workspace-root=false
COPY api/ api/
RUN npm run build --workspace=api

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace=api --include-workspace-root=false --omit=dev && mkdir -p api/node_modules

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json ./
COPY api/package.json api/
COPY --from=deps /app/api/node_modules api/node_modules
COPY api/migrations api/migrations
COPY --from=build /app/api/dist api/dist
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
WORKDIR /app/api
ENV UPLOAD_DIR=/data/uploads PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "dist/main.js"]
