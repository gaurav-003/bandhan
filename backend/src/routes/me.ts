// Apna data — DPDP: user apna data export kar sake aur account delete kar sake.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { revokeAllRefreshTokens } from '../lib/tokens';
import { logAudit } from '../lib/audit';
import { deletePhoto } from '../lib/storage';

const router = Router();

const deleteSchema = z.object({
  confirm: z.literal('DELETE', { error: 'Delete karne ke liye confirm me DELETE likho' }),
});

// Apna saara data ek JSON me export karo.
router.get('/export', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: {
        profile: { include: { photos: true, verification: true } },
        subscriptions: { include: { package: true } },
        payments: true,
        interestsSent: true,
        interestsReceived: true,
        shortlists: true,
      },
    });
    if (!user) {
      res.status(404).json({ error: 'User nahi mila' });
      return;
    }
    const { passwordHash: _omit, ...safeUser } = user;
    await logAudit(user.id, 'data_export', req);
    res.json({ exportedAt: new Date().toISOString(), data: safeUser });
  } catch (err) {
    console.error('[me/export]', err);
    res.status(500).json({ error: 'Export fail ho gaya' });
  }
});

// Account + profile + photos (storage se bhi) delete karo. Ye wapas nahi aata.
router.delete('/', requireAuth, validate(deleteSchema), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const profile = await prisma.profile.findUnique({
      where: { userId },
      include: { photos: true },
    });
    if (profile) {
      for (const photo of profile.photos) {
        await deletePhoto(photo.storageKey);
      }
    }
    await logAudit(userId, 'account_delete', req);
    await revokeAllRefreshTokens(userId);
    await prisma.user.delete({ where: { id: userId } });
    res.json({ message: 'Account aur saara data delete ho gaya' });
  } catch (err) {
    console.error('[me/delete]', err);
    res.status(500).json({ error: 'Account delete fail ho gaya' });
  }
});

export default router;
