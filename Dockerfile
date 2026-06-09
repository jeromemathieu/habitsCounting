# --- Étape build : installe les dépendances (better-sqlite3 est natif) ---
FROM node:22-bookworm AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# --- Étape runtime : image légère ---
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/data.sqlite
WORKDIR /app

# Dépendances déjà compilées
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js db.js ./
COPY public ./public

# La base SQLite vit dans un volume pour persister entre redémarrages
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000
CMD ["node", "server.js"]
