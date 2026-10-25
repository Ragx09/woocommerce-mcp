# SEC-05: test-only hostile upstream (chart hostileMcp.enabled, false in every values file). No dependencies.
#   docker build -f services/hostile-mcp/Dockerfile .
FROM node:24.19.0-alpine3.24
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY services/hostile-mcp/server.mjs ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.mjs"]
