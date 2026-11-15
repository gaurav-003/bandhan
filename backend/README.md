# Bandhan Backend — Phase 1

Matrimonial website ka backend: Express 5 + TypeScript (strict) + Prisma 6 + PostgreSQL 16.2 + Redis 7.4.2.

## Services (VM restart ke baad dobara start karna)

```bash
~/workspace/bandhan-backend/start-services.sh
```

- PostgreSQL 16.2 — pgserver se, **Unix socket only** (koi TCP port nahi).
  Socket dir: `~/workspace/bandhan-backend/pgdata`, database `bandhan`, user `bandhan_app`.
- Redis 7.4.2 — TCP 6379.
- Dono ke binaries/data `/home` me hain, isliye VM restart se mit-te nahi — sirf dobara start karne padte hain.
- **apt se install kiya hua Postgres/Redis VM restart pe mitt jata hai — dobara apt install mat karo.**

## Setup

```bash
cd ~/workspace/bandhan-backend
npm install
npx prisma db push   # tables banao
npm run seed         # 4 packages: FREE / SILVER / GOLD / PLATINUM
npm run build        # tsc strict — zero errors hona chahiye
npm start            # http://127.0.0.1:4000
# dev ke liye: npm run dev (nodemon + tsx)
```

## Env (.env — git me mat daalo)

```
PORT=4000
NODE_ENV=development
DATABASE_URL=postgresql://bandhan_app:PASS@localhost/bandhan?host=/home/hatch/workspace/bandhan-backend/pgdata
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=<random>
JWT_EXPIRES_IN=7d
```

## Endpoints (Phase 1)

| Method | Route | Auth | Kaam |
|---|---|---|---|
| GET | /health | — | db + redis status |
| GET | /api/packages | — | 4 packages list |
| POST | /api/auth/register | — | email/password/phone → JWT |
| POST | /api/auth/login | — | JWT (galat ho to generic 401) |
| POST | /api/auth/send-otp | — | 6-digit OTP, Redis 10 min (DEV MODE: response me `devOtp`) |
| POST | /api/auth/verify-otp | — | OTP match → isVerified=true + JWT |
| GET | /api/auth/me | JWT | current user (passwordHash kabhi nahi) |
| POST | /api/profiles | JWT | apna profile banao (ek hi, dobara 409) |
| GET | /api/profiles/me | JWT | apna profile + photos |
| PATCH | /api/profiles/me | JWT | apna profile update |
| GET | /api/profiles | JWT | search: gender/minAge/maxAge/city/education/profession, pagination |
| GET | /api/profiles/:id | JWT | ek profile + photos |
| POST | /api/profiles/me/photos | JWT | photo upload (JPEG/PNG/WebP, max 5MB, max 5, Sharp 800px resize) |
| DELETE | /api/profiles/me/photos/:photoId | JWT | photo delete (file bhi) |
| GET | /uploads/:file | — | uploaded photo serve |

Rate limits: auth routes 20 req / 15 min; baaki API 300 req / 15 min.

## Phase 1 me NAHI hai (Phase 2)

- Razorpay payment flow (sirf Payment table bani hai)
- Package gating (search me sab kuch dikhta hai)
- Real OTP SMS/email (abhi DEV MODE — `devOtp` response me)
- Interest / Shortlist endpoints (tables bani hain, routes Phase 2 me)
- Admin panel endpoints

## Testing

```bash
/tmp/bandhan-phase1-tests.sh
```

Phase 1 result: **30/30 tests pass** (health, auth, OTP, profile CRUD, search filters, photo upload/delete, 401/404/409 cases). Full log: `/tmp/bandhan-test-results.txt`

## Notes / gotchas

- **ts-node TypeScript 7 ke saath nahi chalta** (ts-node 10.9.2 ko TS 5 ka API chahiye) — isliye dev/seed ke liye `tsx` use hota hai. `npm run build` me `tsc` 7 chalta hai.
- **tsconfig**: TS 7 me `moduleResolution: "node"` hata diya gaya hai — `"bundler"` use hota hai. Output `dist/src/index.js` me aata hai (rootDir `.` hai).
- **Prisma 8 RC mat install karna** — uska CLI badal gaya hai (generate/db commands nahi hain). Stable **6.14.0** use karo. Prisma engine binaries Node se download nahi hote (egress proxy ECONNRESET) — curl se `binaries.prisma.sh` se download karke `node_modules/@prisma/engines/` + `~/.cache/prisma/master/<commit>/` me rakhne padte hain (commit `717184b7b35ea05dfa71a3236b7af656013e1e49`, target `debian-openssl-3.0.x`).
- OTP Redis key format: `otp:<email-ya-phone>` (lowercase), 600s expiry.
- Uploads: `uploads/` folder, naam `<profileId>-<timestamp>-<random>.jpg`, Sharp se max 800px + JPEG q82.
