// Bandhan backend — Phase 1 entry point.
// Run: npm run dev (nodemon + ts-node) ya npm run build && npm start
import 'dotenv/config';
import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import authRoutes from './routes/auth';
import profileRoutes from './routes/profiles';
import packageRoutes from './routes/packages';

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(helmet());
app.use(
  cors({
    // TEMPORARY (tunnel demo): site alag origin (Muse card) se host hoti hai,
    // isliye kisi bhi origin se API call allow karo. Permanent hosting par
    // isko wapas site ke asli domain tak simit karna hai.
    origin: true,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

// Uploaded photos serve karo: GET /uploads/<filename>
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Public pages (email-confirm ke baad password set karne wala page): GET /confirmed.html
app.use(express.static(path.join(__dirname, '..', 'public')));

// Auth routes pe strict rate limit — brute force rokne ke liye.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Bahut zyada requests — 15 minute baad dobara try karo' },
});
app.use('/api/auth', authLimiter);

// General API rate limit.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Bahut zyada requests — thoda ruk ke dobara try karo' },
});
app.use('/api', apiLimiter);

app.get('/health', async (_req: Request, res: Response) => {
  let db = 'down';
  let cache = 'down';
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = 'up';
  } catch (e) {
    console.error('[health] db down:', (e as Error).message);
  }
  try {
    const pong = await redis.ping();
    if (pong === 'PONG') cache = 'up';
  } catch (e) {
    console.error('[health] redis down:', (e as Error).message);
  }
  const ok = db === 'up' && cache === 'up';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    db,
    redis: cache,
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/packages', packageRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route nahi mila' });
});

// Global error handler — kabhi bhi stack trace client ko mat bhejo.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Server me kuch gadbad ho gayi' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bandhan backend chal raha hai — http://127.0.0.1:${PORT}`);
  console.log(`Health: http://127.0.0.1:${PORT}/health`);
});

async function shutdown(signal: string) {
  console.log(`\n${signal} — server band ho raha hai...`);
  server.close(async () => {
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export default app;
