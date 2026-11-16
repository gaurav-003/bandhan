// Redis-based fixed-window rate limiter (express-rate-limit in-memory hatao).
// Upstash Redis compatible — sirf INCR/EXPIRE use hota hai.
// Redis down ho to request allow karo (log karke), taaki outage me site na ruke.
import { Request, Response, NextFunction } from 'express';
import { redis } from './redis';

interface RedisLimiterOptions {
  prefix: string;
  windowSeconds: number;
  max: number;
  /** Rate-limit key — default: client IP. */
  keyBy?: (req: Request) => string;
  message?: string;
}

export function redisRateLimit(opts: RedisLimiterOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `${opts.prefix}:${opts.keyBy ? opts.keyBy(req) : req.ip ?? 'unknown'}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, opts.windowSeconds);
      const ttl = await redis.ttl(key);
      res.setHeader('RateLimit-Limit', String(opts.max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.max - count)));
      if (ttl > 0) res.setHeader('RateLimit-Reset', String(Math.floor(Date.now() / 1000) + ttl));
      if (count > opts.max) {
        res.status(429).json({
          error: opts.message ?? 'Bahut zyada requests — thoda ruk ke dobara try karo',
        });
        return;
      }
      next();
    } catch (err) {
      console.error('[ratelimit] Redis fail, allowing request:', (err as Error).message);
      next();
    }
  };
}
