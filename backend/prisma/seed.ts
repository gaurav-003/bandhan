// Bandhan — package seed data (Phase 1)
// Run: npm run seed
// Prices paise me hain (₹1 = 100 paise).
import { PrismaClient, PackageName } from '@prisma/client';

const prisma = new PrismaClient();

const packages: {
  name: PackageName;
  pricePaise: number;
  durationDays: number;
  maxProfilesVisible: number;
  canSeePhotos: boolean;
  canSeeBiodata: boolean;
  canSeeContacts: boolean;
  canSendInterest: boolean;
  isVerifiedBadge: boolean;
  priorityListing: boolean;
}[] = [
  {
    name: PackageName.FREE,
    pricePaise: 0,
    durationDays: 30,
    maxProfilesVisible: 5,
    canSeePhotos: false,
    canSeeBiodata: false,
    canSeeContacts: false,
    canSendInterest: false,
    isVerifiedBadge: false,
    priorityListing: false,
  },
  {
    name: PackageName.SILVER,
    pricePaise: 99900,
    durationDays: 90,
    maxProfilesVisible: 50,
    canSeePhotos: true,
    canSeeBiodata: true,
    canSeeContacts: false,
    canSendInterest: false,
    isVerifiedBadge: false,
    priorityListing: false,
  },
  {
    name: PackageName.GOLD,
    pricePaise: 249900,
    durationDays: 180,
    maxProfilesVisible: 9999,
    canSeePhotos: true,
    canSeeBiodata: true,
    canSeeContacts: true,
    canSendInterest: true,
    isVerifiedBadge: false,
    priorityListing: false,
  },
  {
    name: PackageName.PLATINUM,
    pricePaise: 499900,
    durationDays: 365,
    maxProfilesVisible: 9999,
    canSeePhotos: true,
    canSeeBiodata: true,
    canSeeContacts: true,
    canSendInterest: true,
    isVerifiedBadge: true,
    priorityListing: true,
  },
];

async function main() {
  for (const pkg of packages) {
    const saved = await prisma.package.upsert({
      where: { name: pkg.name },
      update: { ...pkg },
      create: { ...pkg },
    });
    console.log(`seeded package: ${saved.name} — ₹${saved.pricePaise / 100} / ${saved.durationDays} days`);
  }
}

main()
  .catch((e) => {
    console.error('seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
