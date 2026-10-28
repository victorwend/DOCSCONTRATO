FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api --include-workspace-root || npm install --workspace apps/api --include-workspace-root
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PD_ROOT_DIR=/app
COPY --from=build /app /app
COPY db db
RUN mkdir -p storage && chown -R node:node storage
USER node
EXPOSE 4000
# aplica migrations/seed (idempotentes) e inicia
CMD ["sh", "-c", "node apps/api/dist/db/cli.js migrate && node apps/api/dist/db/cli.js seed && node apps/api/dist/main.js"]
