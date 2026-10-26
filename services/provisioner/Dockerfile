# Build context: repository root.  docker build -f services/provisioner/Dockerfile .
FROM node:24.19.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/provisioner/package.json services/provisioner/
RUN npm ci --workspace services/provisioner --include-workspace-root --no-audit --no-fund
COPY services/provisioner/tsconfig.json services/provisioner/tsconfig.build.json services/provisioner/
COPY services/provisioner/src services/provisioner/src
RUN npm run build -w services/provisioner \
 && npm ci --workspace services/provisioner --omit=dev --no-audit --no-fund

# Helm (D-026: the provisioner runs `helm upgrade --install` of charts/store), built from its pinned release source with a
# patched Go: the official v3.22.1 binary is built with Go 1.26.9 and still carries CVE-2026-111943 (crypto/x509, F-INF-10).
# The module download is verified against the Go checksum database. Back to the official binary once one ships Go >= 1.26.10.
FROM golang:1.26.10-alpine3.24@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS helm
ARG HELM_VERSION=v3.22.1
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
RUN go install -ldflags "-s -w -X helm.sh/helm/v3/internal/version.version=${HELM_VERSION}" "helm.sh/helm/v3/cmd/helm@${HELM_VERSION}" \
 && mv /go/bin/helm /helm

FROM node:24.19.0-alpine3.24
# F-INF-1: patched OS packages, and no npm/npx/corepack at runtime.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=helm /helm /usr/local/bin/helm
COPY charts/store /charts/store
COPY charts/hosted /charts/hosted
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/provisioner/package.json ./package.json
COPY --from=build /app/services/provisioner/dist ./dist
# Writable: /tmp only (Helm cache/config, values files), an emptyDir in the pod.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
