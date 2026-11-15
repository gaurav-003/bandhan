// Auth helpers — bcrypt password hashing + JWT sign/verify.
// Koi secret yahan hardcode nahi hai; sab .env se aata hai.
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET .env me set nahi hai — server start nahi hoga.');
}

const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'];

export interface AuthTokenPayload {
  userId: string;
  email: string;
  role: string;
}

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET as string, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, JWT_SECRET as string);
  if (typeof decoded === 'string' || !decoded.userId || !decoded.email) {
    throw new Error('Invalid token payload');
  }
  return decoded as AuthTokenPayload;
}

/** 6-digit numeric OTP (100000–999999). */
export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ---- Email-confirmation -> set-password flow ----
// Confirm link click ke baad 30-min ka short-lived token milta hai,
// jisse user password set kar sakta hai. Ye normal login JWT se alag hai.
export interface SetPasswordTokenPayload {
  userId: string;
  email: string;
  purpose: 'set_password';
}

export function signSetPasswordToken(userId: string, email: string): string {
  return jwt.sign(
    { userId, email, purpose: 'set_password' },
    JWT_SECRET as string,
    { expiresIn: '30m' },
  );
}

export function verifySetPasswordToken(token: string): SetPasswordTokenPayload {
  const decoded = jwt.verify(token, JWT_SECRET as string);
  if (
    typeof decoded === 'string' ||
    (decoded as Record<string, unknown>).purpose !== 'set_password' ||
    !decoded.userId ||
    !decoded.email
  ) {
    throw new Error('Invalid set-password token');
  }
  return decoded as unknown as SetPasswordTokenPayload;
}
