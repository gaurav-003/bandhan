// Profile routes — sab requireAuth.
// Package gating BACKEND pe enforce hota hai (src/lib/gating.ts):
// Free user ko sirf blurred thumbnail + limited biodata, paid user ko signed
// original photo (5 min) + poora biodata. Frontend CSS blur par bharosa nahi.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { validate, ageFromDob } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { getPermissions, Permissions } from '../lib/gating';
import { uploadPhoto, deletePhoto, signedPhotoUrl, verifyPhotoSig, localFilePath } from '../lib/storage';
import { logAudit } from '../lib/audit';
import { cacheGet, cacheSet } from '../lib/cache';

const router = Router();

const MAX_PHOTOS_PER_PROFILE = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DIMENSION = 2000;
const PAGE_SIZE = 20; // fixed — user control nahi kar sakta
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Sirf JPEG/PNG/WebP images allowed hain'));
  },
});

/** Magic bytes check — extension/mimetype par bharosa mat karo. */
function checkMagicBytes(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return true;
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  return false;
}

const profileCreateSchema = z.object({
  gender: z.enum(['MALE', 'FEMALE']),
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  dob: z.coerce.date().refine(
    (d) => {
      const age = ageFromDob(d);
      return age >= 18 && age <= 100;
    },
    { message: 'Age 18 se 100 ke beech honi chahiye' },
  ),
  heightCm: z.number().int().min(120).max(230).optional(),
  education: z.string().min(1).max(100),
  profession: z.string().min(1).max(100),
  incomeAnnual: z.number().int().min(0).optional(),
  city: z.string().min(1).max(80),
  state: z.string().max(80).optional(),
  religion: z.string().max(50).optional(),
  caste: z.string().max(50).optional(),
  maritalStatus: z.string().max(40).optional(),
  about: z.string().max(1000).optional(),
});

const profileUpdateSchema = profileCreateSchema.partial();

const searchQuerySchema = z.object({
  gender: z.enum(['MALE', 'FEMALE']).optional(),
  minAge: z.coerce.number().int().min(18).max(100).optional(),
  maxAge: z.coerce.number().int().min(18).max(100).optional(),
  city: z.string().max(80).optional(),
  education: z.string().max(100).optional(),
  profession: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const verificationSchema = z.object({
  govtIdType: z.enum(['Aadhaar', 'PAN', 'Passport', 'Driving Licence']),
  govtIdLast4: z.string().regex(/^\d{4}$/, 'Sirf last 4 digit daalo'),
});

const photoSelect = {
  select: {
    id: true,
    url: true,
    storageKey: true,
    blurUrl: true,
    isPrimary: true,
    createdAt: true,
  },
  orderBy: { createdAt: 'asc' as const },
};

const profileSelect = {
  id: true,
  userId: true,
  gender: true,
  firstName: true,
  lastName: true,
  dob: true,
  age: true,
  heightCm: true,
  education: true,
  profession: true,
  incomeAnnual: true,
  city: true,
  state: true,
  religion: true,
  caste: true,
  maritalStatus: true,
  about: true,
  isActive: true,
  isVerified: true,
  createdAt: true,
  updatedAt: true,
  photos: photoSelect,
  user: { select: { id: true, email: true, isVerified: true } },
};

type ProfileRow = Awaited<ReturnType<typeof prisma.profile.findUnique>> extends infer T
  ? // Prisma select type — runtime me plain object aata hai, isliye loose type:
    Record<string, unknown> & {
      userId: string;
      photos: Array<Record<string, unknown> & { id: string; url: string; storageKey: string | null; blurUrl: string | null; isPrimary: boolean }>;
      user: { id: string; email: string; isVerified: boolean };
    }
  : never;

/** Viewer ke permissions ke hisaab se profile fields + photo URLs gate karo. */
async function gateProfile(profile: ProfileRow, perms: Permissions, viewerUserId: string) {
  const isOwner = profile.userId === viewerUserId;
  const p: Record<string, unknown> = { ...profile };

  if (!isOwner && !perms.canSeeBiodata) {
    // Free user: sirf basic info — biodata fields chhupao.
    for (const f of ['education', 'profession', 'incomeAnnual', 'about', 'religion', 'caste', 'heightCm', 'maritalStatus', 'dob']) {
      delete p[f];
    }
  }
  if (!isOwner && !perms.canSeeContacts) {
    p.user = { id: (profile.user as { id: string }).id, isVerified: (profile.user as { isVerified: boolean }).isVerified };
  }
  if (isOwner || perms.canSeePhotos) {
    // Original photo — signed URL (5 min expiry).
    p.photos = await Promise.all(
      profile.photos.map(async (ph) => ({
        id: ph.id,
        url: await signedPhotoUrl({ id: ph.id as string, url: ph.url as string, storageKey: ph.storageKey as string | null }),
        blurUrl: ph.blurUrl,
        isPrimary: ph.isPrimary,
        createdAt: ph.createdAt,
      })),
    );
  } else {
    // Free user: sirf blurred thumbnail, original ka URL bilkul nahi.
    p.photos = profile.photos.map((ph) => ({
      id: ph.id,
      url: null,
      blurUrl: ph.blurUrl,
      isPrimary: ph.isPrimary,
      createdAt: ph.createdAt,
    }));
  }
  return p;
}

type SearchQuery = z.infer<typeof searchQuerySchema>;

router.post('/', requireAuth, validate(profileCreateSchema), async (req: Request, res: Response) => {
  const data = req.body as z.infer<typeof profileCreateSchema>;
  try {
    const existing = await prisma.profile.findUnique({ where: { userId: req.user!.userId } });
    if (existing) {
      res.status(409).json({ error: 'Profile pehle se bana hua hai — PATCH /api/profiles/me use karo' });
      return;
    }
    const profile = await prisma.profile.create({
      data: {
        userId: req.user!.userId,
        gender: data.gender,
        firstName: data.firstName,
        lastName: data.lastName,
        dob: data.dob,
        age: ageFromDob(data.dob),
        heightCm: data.heightCm ?? null,
        education: data.education,
        profession: data.profession,
        incomeAnnual: data.incomeAnnual ?? null,
        city: data.city,
        state: data.state ?? '',
        religion: data.religion ?? null,
        caste: data.caste ?? null,
        maritalStatus: data.maritalStatus ?? 'Never Married',
        about: data.about ?? null,
      },
      select: profileSelect,
    });
    res.status(201).json({ profile });
  } catch (err) {
    console.error('[profiles/create]', err);
    res.status(500).json({ error: 'Profile banane me fail ho gaya' });
  }
});

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { userId: req.user!.userId },
      select: profileSelect,
    });
    if (!profile) {
      res.status(404).json({ error: 'Profile abhi bana nahi hai' });
      return;
    }
    const perms = await getPermissions(req.user!.userId);
    res.json({ profile: await gateProfile(profile as unknown as ProfileRow, perms, req.user!.userId) });
  } catch (err) {
    console.error('[profiles/me]', err);
    res.status(500).json({ error: 'Profile fetch fail ho gaya' });
  }
});

router.patch('/me', requireAuth, validate(profileUpdateSchema), async (req: Request, res: Response) => {
  const data = req.body as z.infer<typeof profileUpdateSchema>;
  try {
    const existing = await prisma.profile.findUnique({ where: { userId: req.user!.userId } });
    if (!existing) {
      res.status(404).json({ error: 'Profile abhi bana nahi hai' });
      return;
    }
    const updateData: Record<string, unknown> = { ...data };
    if (data.dob) updateData.age = ageFromDob(data.dob);
    const profile = await prisma.profile.update({
      where: { userId: req.user!.userId },
      data: updateData,
      select: profileSelect,
    });
    res.json({ profile });
  } catch (err) {
    console.error('[profiles/patch]', err);
    res.status(500).json({ error: 'Profile update fail ho gaya' });
  }
});

router.get('/', requireAuth, validate(searchQuerySchema, 'query'), async (req: Request, res: Response) => {
  const q = (req as unknown as { validatedQuery: SearchQuery }).validatedQuery;
  try {
    const perms = await getPermissions(req.user!.userId);
    const cacheKey = `search:${perms.packageName}:${JSON.stringify(q)}:${req.user!.userId}`;
    const cached = await cacheGet<{ profiles: unknown[]; meta: unknown }>(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }
    const where: Record<string, unknown> = { isActive: true };
    if (q.gender) where.gender = q.gender;
    if (q.city) where.city = { contains: q.city, mode: 'insensitive' };
    if (q.education) where.education = { contains: q.education, mode: 'insensitive' };
    if (q.profession) where.profession = { contains: q.profession, mode: 'insensitive' };
    // Age filter — dob ke range me convert karo.
    if (q.minAge !== undefined || q.maxAge !== undefined) {
      const now = new Date();
      const dobFilter: Record<string, Date> = {};
      if (q.maxAge !== undefined) {
        const minDob = new Date(now);
        minDob.setFullYear(now.getFullYear() - q.maxAge - 1);
        minDob.setDate(minDob.getDate() + 1);
        dobFilter.gte = minDob;
      }
      if (q.minAge !== undefined) {
        const maxDob = new Date(now);
        maxDob.setFullYear(now.getFullYear() - q.minAge);
        dobFilter.lte = maxDob;
      }
      where.dob = dobFilter;
    }
    // Free plan: total dikhne wale profiles maxProfilesVisible tak simit.
    const effectivePageSize = PAGE_SIZE;
    const skip = (q.page - 1) * effectivePageSize;
    const maxSkip = Math.max(0, perms.maxProfilesVisible - skip);
    const take = Math.min(effectivePageSize, maxSkip);
    const [profiles, total] = await Promise.all([
      take > 0
        ? prisma.profile.findMany({
            where,
            select: profileSelect,
            orderBy: { createdAt: 'desc' },
            skip,
            take,
          })
        : Promise.resolve([]),
      prisma.profile.count({ where }),
    ]);
    const gated = await Promise.all(
      (profiles as unknown as ProfileRow[]).map((p) => gateProfile(p, perms, req.user!.userId)),
    );
    const result = {
      profiles: gated,
      meta: {
        total: Math.min(total, perms.maxProfilesVisible),
        page: q.page,
        limit: PAGE_SIZE,
        totalPages: Math.ceil(Math.min(total, perms.maxProfilesVisible) / PAGE_SIZE),
        package: perms.packageName,
      },
    };
    await cacheSet(cacheKey, result, 120); // search max 2 min cache
    res.json(result);
  } catch (err) {
    console.error('[profiles/search]', err);
    res.status(500).json({ error: 'Search fail ho gaya' });
  }
});

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await prisma.profile.findUnique({
      where: { id: String(req.params.id) },
      select: profileSelect,
    });
    if (!profile || !profile.isActive) {
      res.status(404).json({ error: 'Profile nahi mila' });
      return;
    }
    const perms = await getPermissions(req.user!.userId);
    await logAudit(req.user!.userId, 'profile_view', req, `profile:${profile.id}`);
    res.json({ profile: await gateProfile(profile as unknown as ProfileRow, perms, req.user!.userId) });
  } catch (err) {
    console.error('[profiles/get]', err);
    res.status(500).json({ error: 'Profile fetch fail ho gaya' });
  }
});

router.post(
  '/me/photos',
  requireAuth,
  (req: Request, res: Response, next) => {
    upload.single('photo')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: 'Photo 5MB se badi nahi ho sakti' });
          return;
        }
        res.status(400).json({ error: `Upload fail: ${err.message}` });
        return;
      }
      if (err instanceof Error) {
        res.status(400).json({ error: err.message });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'photo field me image file bhejo' });
        return;
      }
      // Magic bytes check — mimetype spoof ho sakta hai.
      if (!checkMagicBytes(req.file.buffer)) {
        res.status(400).json({ error: 'File asli image nahi lagti — sirf JPEG/PNG/WebP allowed hain' });
        return;
      }
      const profile = await prisma.profile.findUnique({ where: { userId: req.user!.userId } });
      if (!profile) {
        res.status(404).json({ error: 'Pehle profile banao, phir photo upload karo' });
        return;
      }
      const count = await prisma.photo.count({ where: { profileId: profile.id } });
      if (count >= MAX_PHOTOS_PER_PROFILE) {
        res.status(400).json({ error: `Ek profile pe max ${MAX_PHOTOS_PER_PROFILE} photos allowed hain` });
        return;
      }
      const keyBase = `${profile.id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      // Sharp re-encode: .rotate() EXIF orientation apply karta hai aur EXIF/GPS
      // metadata hata deta hai; max 2000px; JPEG quality 82.
      const original = await sharp(req.file.buffer)
        .rotate()
        .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      // Blurred thumbnail (Free users ke liye) — 200px + heavy blur.
      const blur = await sharp(req.file.buffer)
        .rotate()
        .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
        .blur(25)
        .jpeg({ quality: 60 })
        .toBuffer();
      const uploaded = await uploadPhoto(original, blur, keyBase);
      const photo = await prisma.photo.create({
        data: {
          profileId: profile.id,
          url: uploaded.url,
          storageKey: uploaded.storageKey,
          blurUrl: uploaded.blurUrl,
          isPrimary: count === 0,
        },
      });
      res.status(201).json({ photo });
    } catch (err) {
      console.error('[profiles/photo-upload]', err);
      res.status(500).json({ error: 'Photo upload fail ho gaya' });
    }
  },
);

router.delete('/me/photos/:photoId', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user!.userId } });
    if (!profile) {
      res.status(404).json({ error: 'Profile nahi mila' });
      return;
    }
    const photo = await prisma.photo.findFirst({
      where: { id: String(req.params.photoId), profileId: profile.id },
    });
    if (!photo) {
      res.status(404).json({ error: 'Photo nahi mili' });
      return;
    }
    await prisma.photo.delete({ where: { id: photo.id } });
    // Storage se bhi delete karo — sirf DB se nahi.
    await deletePhoto(photo.storageKey);
    // Agar primary photo delete hui to sabse purani bachi photo ko primary banao.
    if (photo.isPrimary) {
      const next = await prisma.photo.findFirst({
        where: { profileId: profile.id },
        orderBy: { createdAt: 'asc' },
      });
      if (next) await prisma.photo.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    res.json({ message: 'Photo delete ho gayi' });
  } catch (err) {
    console.error('[profiles/photo-delete]', err);
    res.status(500).json({ error: 'Photo delete fail ho gaya' });
  }
});

// ---- Profile verification (Level 2 Govt ID + Level 3 selfie) ----
// Level 1 = emailVerified + phoneVerified (User flags). Yahan Level 2/3 submit hota hai.
// isVerified sirf admin approve karne par true hota hai (src/routes/admin.ts).
router.post(
  '/me/verification',
  requireAuth,
  (req: Request, res: Response, next) => {
    upload.single('selfie')(req, res, (err: unknown) => {
      if (err instanceof Error) {
        res.status(400).json({ error: err.message });
        return;
      }
      next();
    });
  },
  validate(verificationSchema),
  async (req: Request, res: Response) => {
    const { govtIdType, govtIdLast4 } = req.body as z.infer<typeof verificationSchema>;
    try {
      const profile = await prisma.profile.findUnique({ where: { userId: req.user!.userId } });
      if (!profile) {
        res.status(404).json({ error: 'Pehle profile banao' });
        return;
      }
      let selfieUrl: string | undefined;
      let selfieKey: string | undefined;
      if (req.file) {
        if (!checkMagicBytes(req.file.buffer)) {
          res.status(400).json({ error: 'Selfie asli image nahi lagti' });
          return;
        }
        const buf = await sharp(req.file.buffer)
          .rotate()
          .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        const uploaded = await uploadPhoto(buf, buf, `${profile.id}-selfie-${Date.now()}`);
        selfieUrl = uploaded.url;
        selfieKey = uploaded.storageKey;
      }
      const verification = await prisma.verification.upsert({
        where: { profileId: profile.id },
        update: {
          govtIdType,
          govtIdLast4,
          ...(selfieUrl ? { selfieUrl, selfieKey, level: 3 } : { level: 2 }),
          status: 'PENDING',
          reviewedBy: null,
          reviewedAt: null,
          rejectReason: null,
        },
        create: {
          profileId: profile.id,
          govtIdType,
          govtIdLast4,
          selfieUrl: selfieUrl ?? null,
          selfieKey: selfieKey ?? null,
          level: selfieUrl ? 3 : 2,
          status: 'PENDING',
        },
      });
      // Poora ID number kabhi response me mat bhejo — sirf last 4 digit.
      res.status(201).json({
        verification: {
          id: verification.id,
          level: verification.level,
          govtIdType: verification.govtIdType,
          govtIdLast4: verification.govtIdLast4,
          status: verification.status,
        },
        message: 'Verification submit ho gayi — admin review karega',
      });
    } catch (err) {
      console.error('[profiles/verification]', err);
      res.status(500).json({ error: 'Verification submit fail ho gaya' });
    }
  },
);

router.get('/me/verification', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { userId: req.user!.userId } });
    if (!profile) {
      res.status(404).json({ error: 'Profile abhi bana nahi hai' });
      return;
    }
    const verification = await prisma.verification.findUnique({ where: { profileId: profile.id } });
    if (!verification) {
      res.json({ verification: null });
      return;
    }
    res.json({
      verification: {
        id: verification.id,
        level: verification.level,
        govtIdType: verification.govtIdType,
        govtIdLast4: verification.govtIdLast4,
        status: verification.status,
        rejectReason: verification.rejectReason,
      },
    });
  } catch (err) {
    console.error('[profiles/verification-get]', err);
    res.status(500).json({ error: 'Verification fetch fail ho gaya' });
  }
});

export default router;

// ---- Public photo file routes — /api/photos par mount hota hai (index.ts) ----
// Original photo: sirf HMAC-signed URL (5 min) se, aur sirf owner / paid user ko.
// Blurred thumbnail: public hai (blurred hi hai), sirf *-blur.jpg files serve hoti hain.
export const photoFileRouter = Router();

photoFileRouter.get('/thumb/:filename', (req: Request, res: Response) => {
  const filename = String(req.params.filename);
  if (!filename.endsWith('-blur.jpg') || filename.includes('/') || filename.includes('..')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const filePath = localFilePath(filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

photoFileRouter.get('/:photoId/file', requireAuth, async (req: Request, res: Response) => {
  const { sig, exp } = req.query as { sig?: string; exp?: string };
  if (!sig || !exp || !verifyPhotoSig(String(req.params.photoId), sig, exp)) {
    res.status(403).json({ error: 'Link expired ya galat hai — photo dobara kholo' });
    return;
  }
  try {
    const photo = await prisma.photo.findUnique({
      where: { id: String(req.params.photoId) },
      include: { profile: true },
    });
    if (!photo) {
      res.status(404).json({ error: 'Photo nahi mili' });
      return;
    }
    const isOwner = photo.profile.userId === req.user!.userId;
    const perms = await getPermissions(req.user!.userId);
    if (!isOwner && !perms.canSeePhotos) {
      res.status(403).json({ error: 'Photo dekhne ke liye paid package chahiye' });
      return;
    }
    if (photo.storageKey && !photo.url.startsWith('local:')) {
      // Cloudinary/Supabase: provider signed URL par redirect karo.
      const signed = await signedPhotoUrl({ id: photo.id, url: photo.url, storageKey: photo.storageKey });
      res.redirect(302, signed);
      return;
    }
    const filename = photo.storageKey ?? photo.url.replace(/^local:/, '');
    const filePath = localFilePath(filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Photo file nahi mili' });
      return;
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(filePath);
  } catch (err) {
    console.error('[photos/file]', err);
    res.status(500).json({ error: 'Photo fetch fail ho gaya' });
  }
});
