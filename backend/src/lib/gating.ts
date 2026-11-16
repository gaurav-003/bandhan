// Package gating — backend pe enforce hota hai, frontend par bharosa nahi.
// Active subscription nahi hai to FREE permissions milte hain.
import { prisma } from './prisma';

export interface Permissions {
  packageName: string;
  canSeePhotos: boolean;
  canSeeBiodata: boolean;
  canSeeContacts: boolean;
  canSendInterest: boolean;
  maxProfilesVisible: number;
}

export const FREE_PERMISSIONS: Permissions = {
  packageName: 'FREE',
  canSeePhotos: false,
  canSeeBiodata: false,
  canSeeContacts: false,
  canSendInterest: false,
  maxProfilesVisible: 5,
};

export async function getPermissions(userId: string): Promise<Permissions> {
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      status: 'ACTIVE',
      endsAt: { gt: new Date() },
    },
    include: { package: true },
    orderBy: { endsAt: 'desc' },
  });
  if (!sub) return { ...FREE_PERMISSIONS };
  return {
    packageName: sub.package.name,
    canSeePhotos: sub.package.canSeePhotos,
    canSeeBiodata: sub.package.canSeeBiodata,
    canSeeContacts: sub.package.canSeeContacts,
    canSendInterest: sub.package.canSendInterest,
    maxProfilesVisible: sub.package.maxProfilesVisible,
  };
}
