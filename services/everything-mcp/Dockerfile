# GW-13: the reference MCP server (server-everything) as an in-cluster upstream. Version pinned in
# package.json and locked in the root package-lock.json. Build context: repository root.
#   docker build -f services/everything-mcp/Dockerfile .
FROM node:24.19.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/everything-mcp/package.json services/everything-mcp/
RUN npm ci --workspace services/everything-mcp --omit=dev --no-audit --no-fund

FROM node:24.19.0-alpine3.24
# No secrets ever: the server has a get-env tool that returns its whole environment (T-15).
# GZIP_ALLOWED_DOMAINS: its gzip tool may fetch http(s) URLs; only the reserved .invalid TLD is
# allowed (nothing resolves), and the NetworkPolicy denies all egress as well.
ENV NODE_ENV=production PORT=8080 GZIP_ALLOWED_DOMAINS=invalid
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
USER 1000:1000
EXPOSE 8080
CMD ["node", "node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]
