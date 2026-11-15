# Bandhan — Render deploy notes

## Repo layout
- `backend/` — Express + TypeScript API (Postgres + Redis + mail flow). Serves the
  website itself from `backend/public/` (same origin, so the site's relative
  `/api` calls work and no CORS problem remains).
- `render.yaml` — Render Blueprint: 1 free web service (`bandhan-api`) + 1 free
  Postgres DB (`bandhan-db`). The site needs no separate static service.
- `backend/public/index.html` — NOT in the repo yet. It is the exported Bandhan
  site (artifact slug `bandhan`); export it and add it here after the API base
  is switched back to relative `/api` paths (one more artifact edit).

## Deploy steps (in order)
1. Push this repo to GitHub (`bandhan` repo under Gaurav's account).
2. Render dashboard > New > Blueprint > connect the repo > Apply.
   First deploy creates the DB + service; `preDeployCommand` runs
   `prisma db push` + seed (4 packages, idempotent upsert).
3. Upstash (free Redis): sign up, create a free Redis DB, copy its URL.
4. In the Render dashboard, set these env vars on `bandhan-api`:
   - `REDIS_URL` = Upstash URL (TLS, `rediss://...`)
   - `SMTP_PASS` = Gmail 16-digit app password (never commit it)
   - `API_BASE_URL` = `https://bandhan-api.onrender.com` (actual service URL)
   - `FRONTEND_URL` = `https://bandhan-api.onrender.com/confirmed.html`
   Then Manual Deploy > Deploy latest commit.
5. Artifact edit: switch the site's API base back to relative `/api` paths,
   export, and add `index.html` to `backend/public/`; push; Render redeploys.
6. End-to-end test on the live URL: Join (email) -> mail -> confirm ->
   set password -> login -> profile.

## Free-tier limits (told to Gaurav 2026-11-16)
- Web service sleeps after 15 min idle; first request after sleep is slow (~30-60s).
- Free Postgres is deleted after 90 days (Render rule) — upgrade or export data before that.
- Uploaded profile photos live on ephemeral disk: they vanish on redeploy/restart.
  (Later: move to Cloudinary/S3.)
- CORS is temporarily open to any origin (`origin: true` in `src/index.ts`).
  Tighten it to the real site origin at permanent hosting time.
- Local dev still runs on this machine (`~/workspace/bandhan-backend`, tunnel URL
  rotates; see MEMORY.md). The Render DB will be fresh — local test accounts
  (incl. Gaurav's) will need recreating there.
