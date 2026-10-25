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

# Helm, pinned and checksum-verified (D-026: the provisioner runs `helm upgrade --install` of charts/store).
FROM alpine:3.24 AS helm
ARG TARGETARCH=amd64
ARG HELM_VERSION=v3.22.0
ARG HELM_SHA256_amd64=1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb
ARG HELM_SHA256_arm64=f14e804dfee240f55525b667488fe9adca349e63e00c9af634c0beb1421ac310
RUN apk add --no-cache curl \
 && curl -fsSLo /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
 && eval "sum=\$HELM_SHA256_${TARGETARCH}" && echo "${sum}  /tmp/helm.tgz" | sha256sum -c - \
 && tar -xzf /tmp/helm.tgz -C /tmp && mv "/tmp/linux-${TARGETARCH}/helm" /helm

FROM node:24.19.0-alpine3.24
# F-INF-1: patched OS packages, and no npm/npx/corepack at runtime.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=helm /helm /usr/local/bin/helm
COPY charts/store /charts/store
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/provisioner/package.json ./package.json
COPY --from=build /app/services/provisioner/dist ./dist
# Writable: /tmp only (Helm cache/config, values files), an emptyDir in the pod.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
