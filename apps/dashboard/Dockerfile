# Build context: repository root (npm workspaces).  docker build -f apps/dashboard/Dockerfile .
FROM node:24.19.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --workspace apps/dashboard --include-workspace-root --no-audit --no-fund
COPY apps/dashboard apps/dashboard
RUN npm run build -w apps/dashboard

# Static files only: no Node, no secrets, nothing that runs at request time except nginx.
FROM nginxinc/nginx-unprivileged:1.30.4-alpine3.24
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/dashboard/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
# The image's entrypoint scripts rewrite config files; the root filesystem is read-only in the cluster
# and the config is final, so start nginx directly. It writes only to /tmp (an emptyDir).
ENTRYPOINT ["nginx", "-g", "daemon off;"]
EXPOSE 8080
