# Build context: repository root (npm workspaces).  docker build -f services/woo-mcp/Dockerfile .
FROM node:24.19.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/woo-mcp/package.json services/woo-mcp/
RUN npm ci --workspace services/woo-mcp --include-workspace-root --no-audit --no-fund
COPY services/woo-mcp/tsconfig.json services/woo-mcp/tsconfig.build.json services/woo-mcp/
COPY services/woo-mcp/src services/woo-mcp/src
RUN npm run build -w services/woo-mcp \
 && npm ci --workspace services/woo-mcp --omit=dev --no-audit --no-fund

FROM node:24.19.0-alpine3.24
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/woo-mcp/package.json ./package.json
COPY --from=build /app/services/woo-mcp/dist ./dist
# Numeric uid so Kubernetes runAsNonRoot can verify it; nothing is written to disk at runtime.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
