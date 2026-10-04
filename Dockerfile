# Single container: Next.js + REST API + Socket.IO + the CLIP model.
# Needs ~1 GB RAM. Pair with DATABASE_URL (Postgres + pgvector) or mount a
# volume at /data to use the embedded database.

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# bake the embedding model into the image so the first upload is instant
RUN MODEL_CACHE_DIR=/app/.cache/models npm run model:download
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    MODEL_CACHE_DIR=/app/.cache/models \
    PGLITE_DIR=/data/pglite \
    STORAGE_DIR=/data/uploads
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/.cache ./.cache
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/server.ts /app/package.json /app/next.config.mjs /app/tsconfig.json ./
RUN mkdir -p /data && chown -R node:node /data /app/.next /app/.cache
USER node
VOLUME /data
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "server.ts"]
