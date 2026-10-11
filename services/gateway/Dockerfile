# Build context: repository root (npm workspaces).  docker build -f services/gateway/Dockerfile .
FROM node:24.19.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/gateway/package.json services/gateway/
RUN npm ci --workspace services/gateway --include-workspace-root --no-audit --no-fund
COPY services/gateway/tsconfig.json services/gateway/tsconfig.build.json services/gateway/
COPY services/gateway/src services/gateway/src
RUN npm run build -w services/gateway \
 && npm ci --workspace services/gateway --omit=dev --no-audit --no-fund

FROM node:24.19.0-alpine3.24
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/gateway/package.json ./package.json
COPY --from=build /app/services/gateway/dist ./dist
# Numeric uid so Kubernetes runAsNonRoot can verify it; nothing is written to disk at runtime.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
