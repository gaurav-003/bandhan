# Bandhan backend — Koyeb (free tier)
FROM node:24-slim
WORKDIR /app

# Dependencies first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Source (public/ me confirmed.html etc. bhi aata hai)
COPY . .

# Prisma client + TypeScript build (public/ -> dist/public/)
RUN npx prisma generate && npm run build

EXPOSE 4000

# Har start pe: schema sync (idempotent) + packages seed (upsert) + server
CMD ["sh", "-c", "npx prisma db push && npm run seed && npm start"]
