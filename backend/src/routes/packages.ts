// Packages routes — public list (seed data se aata hai).
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const packages = await prisma.package.findMany({
      orderBy: { pricePaise: 'asc' },
    });
    res.json({ packages });
  } catch (err) {
    console.error('[packages]', err);
    res.status(500).json({ error: 'Packages fetch fail ho gaye' });
  }
});

export default router;
