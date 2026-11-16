# Bandhan backend — Koyeb (free tier) deploy notes

Koyeb = free hosting, no credit card. Ye file sirf setup ka record hai —
koi secret isme nahi hai (saare secrets Koyeb dashboard me env vars hain).

## Service

- Repo: `gaurav-003/bandhan` (branch `main`), root directory: `backend`
- Builder: **Dockerfile** (`backend/Dockerfile`, node:24-slim)
- Port: `4000` (Koyeb `PORT` env var deta hai; code `0.0.0.0` par sunta hai)
- Health check: `GET /health` (200 tabhi jab DB + Redis dono up hon)
- Start: `npx prisma db push && npm run seed && npm start`
  (schema sync + package seed dono idempotent hain)

## Env vars (Koyeb dashboard me set karne hain)

- `NODE_ENV=production`
- `DATABASE_URL` — Koyeb free Postgres ka connection string
- `DIRECT_URL` — wahi connection string (Prisma ko directUrl chahiye)
- `REDIS_URL` — Upstash free Redis (`rediss://...`)
- `JWT_SECRET`, `JWT_REFRESH_SECRET` — random 32-byte hex (har env ke liye alag)
- `JWT_EXPIRES_IN=7d`
- `MAIL_PROVIDER=brevo`, `BREVO_API_KEY`
- `STORAGE_PROVIDER=cloudinary`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `API_BASE_URL` — Koyeb service URL (jaise `https://bandhan-api-xxx.koyeb.app`)
- `FRONTEND_URL` — `<koyeb-url>/confirmed.html,<koyeb-url>,https://gaurav-003.github.io`
  (pehla entry confirm-redirect ka target hai)

## Site (frontend)

Site (Muse artifact `bandhan`) ka `API_BASE` isi Koyeb URL par point karta hai.
Site ko Koyeb se same-origin serve karne ke liye artifact ka export
`backend/public/index.html` me daalo aur push karo — Koyeb auto-redeploy karega.

## Limits (free tier, jaanne layak)

- Service 1 ghante idle raha to sota hai; pehla request 3–5s me jaag jata hai.
- UptimeRobot se har 5 min `/health` ping karke awake rakha ja sakta hai.
- Koyeb free Postgres: 1 GB storage, 5 compute-hours/month (limit lage to Neon pe jao).
- CORS abhi temporarily koi bhi origin allow karta hai (`src/index.ts` me TEMPORARY
  comment) — GoDaddy/live hosting par wapas allowlist par karna hai.
