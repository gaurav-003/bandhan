// Auth routes — register / login / OTP / me + EMAIL CONFIRMATION flow + refresh tokens.
// Email confirmation flow: request-confirmation -> mail me link -> confirm (302 redirect)
// -> set-password. Link single-use hai (confirm par token delete hota hai).
// OTP: 1 ghante me max 5 send, 5 galat try par 15 min block (src/lib/otp.ts).
// Tokens: access 15 min + refresh 7 din with rotation (src/lib/tokens.ts).
// Production me devOtp / devConfirmUrl kabhi response me nahi aate.
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import {
  hashPassword,
  comparePassword,
  generateOtp,
  signSetPasswordToken,
  verifySetPasswordToken,
} from '../lib/auth';
import { issueTokenPair, rotateRefreshToken, revokeRefreshToken, revokeAllRefreshTokens } from '../lib/tokens';
import { checkOtpSendAllowed, storeOtp, checkOtp } from '../lib/otp';
import { sendConfirmationEmail } from '../lib/mail';
import { validate, publicUser } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { logAudit } from '../lib/audit';

const router = Router();
const isDev = process.env.NODE_ENV === 'development';

// Email confirmation token: 24 ghante valid.
const CONFIRM_TTL_SECONDS = 24 * 60 * 60;
const CONFIRM_PREFIX = 'email-confirm:';
// Ek email pe 1 ghante me max 5 confirmation requests.
const CONFIRM_RATE_LIMIT = 5;
const CONFIRM_RATE_WINDOW_SECONDS = 60 * 60;
const CONFIRM_RATE_PREFIX = 'email-confirm-rate:';

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:4000';
// FRONTEND_URL comma-list ho sakta hai (CORS ke liye) — redirect ke liye pehla origin lo.
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://127.0.0.1:3000').split(',')[0].trim();

const registerSchema = z.object({
  email: z.string().email('Valid email chahiye'),
  password: z.string().min(8, 'Password kam se kam 8 characters ka ho'),
  phone: z.string().min(10, 'Valid phone number chahiye').max(15).optional(),
  firstName: z.string().min(1, 'First name chahiye').max(50),
  lastName: z.string().min(1, 'Last name chahiye').max(50),
});

const loginSchema = z.object({
  email: z.string().email('Valid email chahiye'),
  password: z.string().min(1, 'Password chahiye'),
});

const sendOtpSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(10).max(15).optional(),
  })
  .refine((d) => d.email || d.phone, { message: 'email ya phone me se ek chahiye' });

const verifyOtpSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(10).max(15).optional(),
    otp: z.string().length(6, 'OTP 6 digit ka hota hai'),
  })
  .refine((d) => d.email || d.phone, { message: 'email ya phone me se ek chahiye' });

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken chahiye'),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken chahiye').optional(),
});

/** Login/register response — `token` purana naam hai (frontend compat), accessToken naya. */
async function tokenResponse(user: { id: string; email: string; role: string }) {
  const pair = await issueTokenPair({ userId: user.id, email: user.email, role: user.role });
  return { token: pair.accessToken, accessToken: pair.accessToken, refreshToken: pair.refreshToken };
}

router.post('/register', validate(registerSchema), async (req: Request, res: Response) => {
  const { email, password, phone, firstName, lastName } = req.body as z.infer<typeof registerSchema>;
  try {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] },
    });
    if (existing) {
      res.status(409).json({ error: 'Email ya phone pehle se registered hai' });
      return;
    }
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash, phone: phone ?? null },
    });
    res.status(201).json({
      ...(await tokenResponse(user)),
      user: { ...publicUser(user), firstName, lastName },
      message: 'Account ban gaya. Ab apna profile banao.',
    });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'Registration fail ho gaya' });
  }
});

router.post('/login', validate(loginSchema), async (req: Request, res: Response) => {
  const { email, password } = req.body as z.infer<typeof loginSchema>;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    // Generic message — ye mat batao ki email galat hai ya password.
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    // Email confirm to hua par password abhi tak set nahi hua.
    if (!user.passwordHash) {
      res.status(401).json({ error: 'Pehle email confirm karke password set karo' });
      return;
    }
    if (!(await comparePassword(password, user.passwordHash))) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    await logAudit(user.id, 'login', req);
    res.json({ ...(await tokenResponse(user)), user: publicUser(user) });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Login fail ho gaya' });
  }
});

// Access token expire hone par refresh token se naya pair lo (rotation).
router.post('/refresh', validate(refreshSchema), async (req: Request, res: Response) => {
  const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
  try {
    const pair = await rotateRefreshToken(refreshToken);
    res.json({ token: pair.accessToken, accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

router.post('/logout', requireAuth, validate(logoutSchema), async (req: Request, res: Response) => {
  const { refreshToken } = req.body as z.infer<typeof logoutSchema>;
  try {
    if (refreshToken) await revokeRefreshToken(refreshToken);
    await logAudit(req.user!.userId, 'logout', req);
    res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('[auth/logout]', err);
    res.status(500).json({ error: 'Logout fail ho gaya' });
  }
});

router.post('/send-otp', validate(sendOtpSchema), async (req: Request, res: Response) => {
  const { email, phone } = req.body as z.infer<typeof sendOtpSchema>;
  const identifier = (email ?? phone) as string;
  try {
    const allowed = await checkOtpSendAllowed(identifier);
    if (!allowed) {
      res.status(429).json({ error: 'Bahut zyada OTP requests — 1 ghante baad dobara try karo' });
      return;
    }
    const otp = generateOtp();
    await storeOtp(identifier, otp);
    // DEV MODE only: OTP console pe log hota hai. Production me kabhi
    // response me nahi aata — asli SMS/email provider se bhejna hoga.
    console.log(`[auth/otp] OTP for ${identifier} generated (10 min valid)`);
    res.json({
      message: 'OTP bhej diya gaya hai (10 minute valid)',
      ...(isDev ? { devOtp: otp } : {}),
    });
  } catch (err) {
    console.error('[auth/send-otp]', err);
    res.status(500).json({ error: 'OTP bhejne me fail ho gaya' });
  }
});

router.post('/verify-otp', validate(verifyOtpSchema), async (req: Request, res: Response) => {
  const { email, phone, otp } = req.body as z.infer<typeof verifyOtpSchema>;
  const identifier = (email ?? phone) as string;
  try {
    const result = await checkOtp(identifier, otp);
    if (result === 'blocked') {
      res.status(429).json({ error: 'Bahut zyada galat OTP — 15 minute baad dobara try karo' });
      return;
    }
    if (result !== 'ok') {
      res.status(400).json({ error: 'Invalid ya expired OTP' });
      return;
    }
    const user = await prisma.user.findFirst({
      where: email ? { email } : { phone },
    });
    if (!user) {
      res.status(404).json({ error: 'Is email/phone se koi account nahi mila' });
      return;
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true, ...(email ? { emailVerified: true } : { phoneVerified: true }) },
    });
    await logAudit(updated.id, 'otp_verified', req);
    res.json({
      ...(await tokenResponse(updated)),
      user: publicUser(updated),
      message: 'OTP verified — account verify ho gaya',
    });
  } catch (err) {
    console.error('[auth/verify-otp]', err);
    res.status(500).json({ error: 'OTP verify fail ho gaya' });
  }
});

const requestConfirmationSchema = z.object({
  email: z.string().email('Valid email chahiye'),
});

const confirmQuerySchema = z.object({
  token: z.string().min(1, 'Token chahiye'),
});

const setPasswordSchema = z.object({
  setToken: z.string().min(1, 'setToken chahiye'),
  password: z.string().min(8, 'Password kam se kam 8 characters ka ho'),
});

// ---- Email confirmation flow ----
// Step 1: user email deta hai -> confirmation mail jata hai.
router.post('/request-confirmation', validate(requestConfirmationSchema), async (req: Request, res: Response) => {
  const { email } = req.body as z.infer<typeof requestConfirmationSchema>;
  const normalizedEmail = email.toLowerCase();
  try {
    // Rate limit: ek email pe 1 ghante me max 5 requests.
    const rateKey = `${CONFIRM_RATE_PREFIX}${normalizedEmail}`;
    const count = await redis.incr(rateKey);
    if (count === 1) await redis.expire(rateKey, CONFIRM_RATE_WINDOW_SECONDS);
    if (count > CONFIRM_RATE_LIMIT) {
      res.status(429).json({ error: 'Bahut zyada requests — 1 ghante baad dobara try karo' });
      return;
    }

    let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      // Naya user banao — bina password ke (password confirm ke baad set hoga).
      user = await prisma.user.create({
        data: { email: normalizedEmail, passwordHash: null, emailVerified: false },
      });
    }

    // Pehle se verified + password set hai to mail dobara mat bhejo
    // (wo seedha login kar sakta hai) — par response hamesha generic rakho
    // taaki pata na chale ki email registered hai ya nahi.
    if (user.emailVerified && user.passwordHash) {
      res.json({ message: 'Agar ye email registered hai to confirmation mail bhej diya gaya hai' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    await redis.set(`${CONFIRM_PREFIX}${token}`, user.id, 'EX', CONFIRM_TTL_SECONDS);
    const confirmUrl = `${API_BASE_URL}/api/auth/confirm?token=${token}`;

    try {
      await sendConfirmationEmail(normalizedEmail, confirmUrl);
    } catch (err) {
      // Email fail ho to bhi flow mat todo — dev mode me URL response me milta hai.
      console.error('[auth/request-confirmation] email fail:', (err as Error).message);
    }

    // DEV MODE only: confirm URL response me milta hai taaki bina real mail
    // provider ke bhi testing ho sake. Production me kabhi nahi.
    res.json({
      message: 'Agar ye email registered hai to confirmation mail bhej diya gaya hai',
      ...(isDev ? { devConfirmUrl: confirmUrl } : {}),
    });
  } catch (err) {
    console.error('[auth/request-confirmation]', err);
    res.status(500).json({ error: 'Confirmation mail bhejne me fail ho gaya' });
  }
});

// Step 2: user mail me link pe click karta hai -> verify karke website pe redirect.
// Token single-use hai — yahan delete hota hai, dobara click par 400 aayega.
router.get('/confirm', validate(confirmQuerySchema, 'query'), async (req: Request, res: Response) => {
  const { token } = (req as unknown as { validatedQuery: z.infer<typeof confirmQuerySchema> }).validatedQuery;
  try {
    const userId = await redis.get(`${CONFIRM_PREFIX}${token}`);
    if (!userId) {
      res.status(400).json({ error: 'Link expired ya galat hai' });
      return;
    }
    await redis.del(`${CONFIRM_PREFIX}${token}`);
    const user = await prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true, isVerified: true },
    });
    await logAudit(user.id, 'email_confirmed', req);
    // 30-min ka set-password token — website isse password form kholegi.
    const setToken = signSetPasswordToken(user.id, user.email);
    const separator = FRONTEND_URL.includes('?') ? '&' : '?';
    const redirectUrl =
      `${FRONTEND_URL}${separator}emailConfirmed=1` +
      `&email=${encodeURIComponent(user.email)}` +
      `&setToken=${setToken}`;
    res.redirect(302, redirectUrl);
  } catch (err) {
    console.error('[auth/confirm]', err);
    res.status(500).json({ error: 'Confirmation fail ho gaya' });
  }
});

// Step 3: redirect ke baad website password puchti hai -> account ready.
router.post('/set-password', validate(setPasswordSchema), async (req: Request, res: Response) => {
  const { setToken, password } = req.body as z.infer<typeof setPasswordSchema>;
  try {
    let payload;
    try {
      payload = verifySetPasswordToken(setToken);
    } catch {
      res.status(400).json({ error: 'Link expired ya galat hai — dobara confirmation mail mangwao' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || user.email !== payload.email) {
      res.status(400).json({ error: 'Link expired ya galat hai — dobara confirmation mail mangwao' });
      return;
    }
    const passwordHash = await hashPassword(password);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, isVerified: true, emailVerified: true },
    });
    // Password change par saare purane refresh tokens revoke karo.
    await revokeAllRefreshTokens(user.id);
    await logAudit(updated.id, 'password_change', req);
    res.json({
      ...(await tokenResponse(updated)),
      user: publicUser(updated),
      message: 'Password set ho gaya — account ready hai!',
    });
  } catch (err) {
    console.error('[auth/set-password]', err);
    res.status(500).json({ error: 'Password set karne me fail ho gaya' });
  }
});

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { profile: { select: { id: true } } },
    });
    if (!user) {
      res.status(404).json({ error: 'User nahi mila' });
      return;
    }
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('[auth/me]', err);
    res.status(500).json({ error: 'User fetch fail ho gaya' });
  }
});

export default router;
