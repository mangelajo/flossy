FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js password.js rate-limit.js durable.js verify-error.js ./
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
HEALTHCHECK --interval=5m --timeout=5s CMD wget --spider -q "http://127.0.0.1:3000/api/health" || exit 1
CMD ["node", "server.js"]
