FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# nginx sin root (escucha en 8080): funciona igual en docker compose y en OpenShift/Kubernetes,
# que arrancan el contenedor con un UID arbitrario.
FROM nginxinc/nginx-unprivileged:alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=5m --timeout=5s CMD wget --spider -q "http://127.0.0.1:8080/" || exit 1
