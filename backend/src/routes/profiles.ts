// Profile routes — sab requireAuth.
// Phase 1 me package gating NAHI hai (wo Phase 2 me aayega) — search me
// saare active profiles + photos + biodata dikhte hain.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { validate, ageFromDob } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';

const router = Router();

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_PHOTOS_PER_PROFILE = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Sirf JPEG/PNG/WebP images allowed hain'));
  },
});

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
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

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
  photos: { orderBy: { createdAt: 'asc' as const } },
  user: { select: { id: true, email: true, isVerified: true } },
};

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
    res.json({ profile });
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
    const skip = (q.page - 1) * q.limit;
    const [profiles, total] = await Promise.all([
      prisma.profile.findMany({
        where,
        select: profileSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take: q.limit,
      }),
      prisma.profile.count({ where }),
    ]);
    res.json({
      profiles,
      meta: { total, page: q.page, limit: q.limit, totalPages: Math.ceil(total / q.limit) },
    });
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
    res.json({ profile });
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
      const filename = `${profile.id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
      const filepath = path.join(UPLOADS_DIR, filename);
      // Sharp se max 800px width pe resize + JPEG me convert (quality 82).
      await sharp(req.file.buffer)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(filepath);
      const photo = await prisma.photo.create({
        data: {
          profileId: profile.id,
          url: `/uploads/${filename}`,
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
    const filePath = path.join(UPLOADS_DIR, path.basename(photo.url));
    fs.unlink(filePath, () => undefined);
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

export default router;
