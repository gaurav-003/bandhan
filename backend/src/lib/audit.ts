// Audit log helper — fire-and-forget, log fail hone par request kabhi mat todo.
import { Request } from 'express';
import { prisma } from './prisma';

export async function logAudit(
  userId: string | null,
  action: string,
  req?: Request,
  details?: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        ip: req ? (req.ip ?? req.headers['x-forwarded-for']?.toString() ?? null) : null,
        userAgent: req ? (req.headers['user-agent'] ?? null) : null,
        details: details ?? null,
      },
    });
  } catch (err) {
    console.error('[audit] log fail:', (err as Error).message);
  }
}
