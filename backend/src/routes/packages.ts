// Packages routes — public list (seed data se aata hai). 1 ghante Redis cache.
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { cacheGet, cacheSet } from '../lib/cache';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const cached = await cacheGet<{ packages: unknown[] }>('packages:list');
    if (cached) {
      res.json(cached);
      return;
    }
    const packages = await prisma.package.findMany({
      orderBy: { pricePaise: 'asc' },
    });
    const result = { packages };
    await cacheSet('packages:list', result, 3600);
    res.json(result);
  } catch (err) {
    console.error('[packages]', err);
    res.status(500).json({ error: 'Packages fetch fail ho gaye' });
  }
});

export default router;
