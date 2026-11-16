// Admin routes — verification approve/reject + audit log list. Sab admin-only.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validate';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { logAudit } from '../lib/audit';

const router = Router();
router.use(requireAuth, requireAdmin);

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

const auditQuerySchema = z.object({
  action: z.string().max(50).optional(),
  userId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

// Pending verifications ki list.
router.get('/verifications', async (_req: Request, res: Response) => {
  try {
    const verifications = await prisma.verification.findMany({
      where: { status: 'PENDING' },
      include: { profile: { select: { id: true, firstName: true, lastName: true, city: true, userId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    // govtIdLast4 admin ko dikhta hai (sirf last 4 digit hi store hote hain).
    res.json({ verifications });
  } catch (err) {
    console.error('[admin/verifications]', err);
    res.status(500).json({ error: 'Verifications fetch fail ho gayi' });
  }
});

router.post('/verifications/:id/approve', async (req: Request, res: Response) => {
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!verification) {
      res.status(404).json({ error: 'Verification nahi mili' });
      return;
    }
    const updated = await prisma.verification.update({
      where: { id: verification.id },
      data: { status: 'APPROVED', reviewedBy: req.user!.userId, reviewedAt: new Date() },
    });
    await prisma.profile.update({
      where: { id: verification.profileId },
      data: { isVerified: true },
    });
    await logAudit(req.user!.userId, 'admin_approve', req, `verification:${verification.id} profile:${verification.profileId}`);
    res.json({ verification: updated });
  } catch (err) {
    console.error('[admin/approve]', err);
    res.status(500).json({ error: 'Approve fail ho gaya' });
  }
});

router.post('/verifications/:id/reject', validate(rejectSchema), async (req: Request, res: Response) => {
  const { reason } = req.body as z.infer<typeof rejectSchema>;
  try {
    const verification = await prisma.verification.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!verification) {
      res.status(404).json({ error: 'Verification nahi mili' });
      return;
    }
    const updated = await prisma.verification.update({
      where: { id: verification.id },
      data: {
        status: 'REJECTED',
        reviewedBy: req.user!.userId,
        reviewedAt: new Date(),
        rejectReason: reason ?? null,
      },
    });
    await logAudit(req.user!.userId, 'admin_reject', req, `verification:${verification.id} profile:${verification.profileId}`);
    res.json({ verification: updated });
  } catch (err) {
    console.error('[admin/reject]', err);
    res.status(500).json({ error: 'Reject fail ho gaya' });
  }
});

// Audit log list — admin hi dekh sakta hai.
router.get('/audit-logs', validate(auditQuerySchema, 'query'), async (req: Request, res: Response) => {
  const q = (req as unknown as { validatedQuery: z.infer<typeof auditQuerySchema> }).validatedQuery;
  try {
    const where: Record<string, unknown> = {};
    if (q.action) where.action = q.action;
    if (q.userId) where.userId = q.userId;
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * 20,
        take: 20,
      }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ logs, meta: { total, page: q.page, totalPages: Math.ceil(total / 20) } });
  } catch (err) {
    console.error('[admin/audit-logs]', err);
    res.status(500).json({ error: 'Audit logs fetch fail ho gaye' });
  }
});

export default router;
