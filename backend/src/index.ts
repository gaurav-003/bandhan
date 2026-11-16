// Bandhan backend — Phase 1 + P0/P1/P2 updates.
// Run: npm run dev (nodemon + ts-node) ya npm run build && npm start
import 'dotenv/config';
import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { redisRateLimit } from './lib/ratelimit';
import { initSentry, captureError } from './lib/sentry';
import { startWorkers } from './lib/queue';
import authRoutes from './routes/auth';
import profileRoutes, { photoFileRouter } from './routes/profiles';
import packageRoutes from './routes/packages';
import interestRoutes from './routes/interests';
import paymentRoutes from './routes/payments';
import adminRoutes from './routes/admin';
import meRoutes from './routes/me';

const app = express();
const PORT = Number(process.env.PORT || 4000);

// ---- CORS: TEMPORARY — tunnel testing ke liye koi bhi origin allow hai (neeche dekho).
// Default: local dev URLs. '*' kabhi nahi.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://127.0.0.1:3000,http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      // TEMPORARY (tunnel testing, 16 Nov 2026): Space/Pages ka origin abhi fixed
      // nahi hai, isliye koi bhi origin allow — hosting pe wapas allowlist par jayega.
      void allowedOrigins;
      callback(null, true);
    },
    credentials: true,
  }),
);

// Razorpay webhook ko raw body chahiye (signature verify ke liye) —
// isliye webhook route express.json() se PEHLE raw parser se guzarta hai.
app.use(
  '/api/payments/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { rawBody?: Buffer }).rawBody = req.body as Buffer;
    next();
  },
);
app.use(express.json({ limit: '1mb' }));

// Public pages (email-confirm ke baad password set karne wala page): GET /confirmed.html
// NOTE: /uploads static route hata diya gaya hai — photos sirf signed URL se milti hain.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Redis-based rate limits (in-memory limiters hata diye gaye) ----
const authLimiter = redisRateLimit({
  prefix: 'rl:auth',
  windowSeconds: 15 * 60,
  max: 30,
  message: 'Bahut zyada requests — 15 minute baad dobara try karo',
});
app.use('/api/auth', authLimiter);

const mailLimiter = redisRateLimit({
  prefix: 'rl:mail',
  windowSeconds: 60 * 60,
  max: 30,
  message: 'Bahut zyada mail requests — 1 ghante baad dobara try karo',
});
app.use('/api/auth/request-confirmation', mailLimiter);
app.use('/api/auth/send-otp', mailLimiter);

const apiLimiter = redisRateLimit({
  prefix: 'rl:api',
  windowSeconds: 15 * 60,
  max: 300,
  message: 'Bahut zyada requests — thoda ruk ke dobara try karo',
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
app.use('/api/photos', photoFileRouter);
app.use('/api/packages', packageRoutes);
app.use('/api/interests', interestRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/me', meRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route nahi mila' });
});

// Global error handler — kabhi bhi stack trace client ko mat bhejo.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err.message.startsWith('CORS:')) {
    res.status(403).json({ error: 'Origin allowed nahi hai' });
    return;
  }
  captureError(err);
  res.status(500).json({ error: 'Server me kuch gadbad ho gayi' });
});

void initSentry();
try {
  startWorkers();
  void (async () => {
    const { scheduleDailyReminders } = await import('./lib/queue');
    await scheduleDailyReminders();
  })().catch((e) => console.error('[queue] reminders schedule fail:', (e as Error).message));
} catch (err) {
  console.error('[queue] workers start fail:', (err as Error).message);
}

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
