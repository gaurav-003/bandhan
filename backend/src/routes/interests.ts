// Interest routes — send / accept / decline / list.
// Send karne ke liye package me canSendInterest hona chahiye (backend gating).
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { getPermissions } from '../lib/gating';
import { logAudit } from '../lib/audit';

const router = Router();

const sendSchema = z.object({
  toUserId: z.string().min(1, 'toUserId chahiye'),
});

const respondSchema = z.object({
  status: z.enum(['ACCEPTED', 'DECLINED']),
});

router.post('/', requireAuth, validate(sendSchema), async (req: Request, res: Response) => {
  const { toUserId } = req.body as z.infer<typeof sendSchema>;
  try {
    if (toUserId === req.user!.userId) {
      res.status(400).json({ error: 'Khud ko interest nahi bhej sakte' });
      return;
    }
    const perms = await getPermissions(req.user!.userId);
    if (!perms.canSendInterest) {
      res.status(403).json({ error: 'Interest bhejne ke liye Gold ya Platinum package chahiye' });
      return;
    }
    const target = await prisma.user.findUnique({ where: { id: toUserId } });
    if (!target) {
      res.status(404).json({ error: 'User nahi mila' });
      return;
    }
    const existing = await prisma.interest.findUnique({
      where: { fromUserId_toUserId: { fromUserId: req.user!.userId, toUserId } },
    });
    if (existing) {
      res.status(409).json({ error: 'Interest pehle se bheja hua hai' });
      return;
    }
    const interest = await prisma.interest.create({
      data: { fromUserId: req.user!.userId, toUserId, status: 'PENDING' },
    });
    await logAudit(req.user!.userId, 'interest_send', req, `to:${toUserId}`);
    res.status(201).json({ interest });
  } catch (err) {
    console.error('[interests/send]', err);
    res.status(500).json({ error: 'Interest bhejne me fail ho gaya' });
  }
});

router.post('/:id/respond', requireAuth, validate(respondSchema), async (req: Request, res: Response) => {
  const { status } = req.body as z.infer<typeof respondSchema>;
  try {
    const interest = await prisma.interest.findUnique({ where: { id: String(req.params.id) } });
    if (!interest || interest.toUserId !== req.user!.userId) {
      res.status(404).json({ error: 'Interest nahi mila' });
      return;
    }
    if (interest.status !== 'PENDING') {
      res.status(400).json({ error: `Interest pehle se ${interest.status} hai` });
      return;
    }
    const updated = await prisma.interest.update({
      where: { id: interest.id },
      data: { status },
    });
    await logAudit(req.user!.userId, status === 'ACCEPTED' ? 'interest_accept' : 'interest_decline', req, `from:${interest.fromUserId}`);
    res.json({ interest: updated });
  } catch (err) {
    console.error('[interests/respond]', err);
    res.status(500).json({ error: 'Interest respond fail ho gaya' });
  }
});

router.get('/received', requireAuth, async (req: Request, res: Response) => {
  try {
    const interests = await prisma.interest.findMany({
      where: { toUserId: req.user!.userId },
      include: { fromUser: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ interests });
  } catch (err) {
    console.error('[interests/received]', err);
    res.status(500).json({ error: 'Interests fetch fail ho gaye' });
  }
});

router.get('/sent', requireAuth, async (req: Request, res: Response) => {
  try {
    const interests = await prisma.interest.findMany({
      where: { fromUserId: req.user!.userId },
      include: { toUser: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ interests });
  } catch (err) {
    console.error('[interests/sent]', err);
    res.status(500).json({ error: 'Interests fetch fail ho gaye' });
  }
});

export default router;
