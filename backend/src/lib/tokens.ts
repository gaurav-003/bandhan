// Access + refresh tokens — rotation + Redis blacklist.
// Access token: 15 min. Refresh token: 7 din, har use par rotate hota hai
// (purana token turant invalid). Logout par refresh token blacklist me jata hai.
// Authorization header (Bearer) abhi bhi chalta hai; domain aane par httpOnly
// cookie me switch karna sirf config change hoga (cookie code yahan nahi hai,
// kyunki domain ke bina cross-site cookie Safari/iPhone par fail hoti hai).
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { redis } from './redis';

const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET .env me set nahi hai — server start nahi hoga.');
}
// Refresh ke liye alag secret behtar hai; set nahi hai to JWT_SECRET use karo.
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET;

const ACCESS_TTL = '15m';
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 din

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AccessPayload {
  userId: string;
  email: string;
  role: string;
  type: 'access';
}

interface RefreshPayload {
  userId: string;
  email: string;
  role: string;
  type: 'refresh';
  jti: string;
}

function refreshKey(jti: string): string {
  return `refresh:${jti}`;
}
function blacklistKey(jti: string): string {
  return `refresh-blacklist:${jti}`;
}
function userRefreshSet(userId: string): string {
  return `refresh:user:${userId}`;
}

export function signAccessToken(payload: { userId: string; email: string; role: string }): string {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

export async function issueTokenPair(payload: {
  userId: string;
  email: string;
  role: string;
}): Promise<TokenPair> {
  const accessToken = signAccessToken(payload);
  const jti = crypto.randomUUID();
  const refreshToken = jwt.sign({ ...payload, type: 'refresh', jti }, REFRESH_SECRET, {
    expiresIn: REFRESH_TTL_SECONDS,
  });
  await redis.set(
    refreshKey(jti),
    JSON.stringify(payload),
    'EX',
    REFRESH_TTL_SECONDS,
  );
  await redis.sadd(userRefreshSet(payload.userId), jti);
  return { accessToken, refreshToken };
}

/** Refresh token verify karo — blacklist + Redis existence dono check hote hain. */
export async function verifyRefreshToken(token: string): Promise<RefreshPayload> {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, REFRESH_SECRET);
  } catch {
    throw new Error('Invalid or expired refresh token');
  }
  const p = decoded as RefreshPayload;
  if (typeof decoded === 'string' || p.type !== 'refresh' || !p.jti || !p.userId) {
    throw new Error('Invalid refresh token');
  }
  const blacklisted = await redis.exists(blacklistKey(p.jti));
  if (blacklisted) throw new Error('Refresh token revoked');
  const stored = await redis.get(refreshKey(p.jti));
  if (!stored) throw new Error('Refresh token revoked or expired');
  return p;
}

/** Purana refresh token rotate karo — purana delete + blacklist, naya pair do. */
export async function rotateRefreshToken(oldToken: string): Promise<TokenPair> {
  const payload = await verifyRefreshToken(oldToken);
  const ttl = await redis.ttl(refreshKey(payload.jti));
  await redis.del(refreshKey(payload.jti));
  await redis.srem(userRefreshSet(payload.userId), payload.jti);
  if (ttl > 0) await redis.set(blacklistKey(payload.jti), '1', 'EX', ttl);
  return issueTokenPair({ userId: payload.userId, email: payload.email, role: payload.role });
}

/** Ek refresh token revoke karo (logout). */
export async function revokeRefreshToken(token: string): Promise<void> {
  try {
    const decoded = jwt.verify(token, REFRESH_SECRET) as RefreshPayload;
    if (decoded?.jti) {
      const ttl = await redis.ttl(refreshKey(decoded.jti));
      await redis.del(refreshKey(decoded.jti));
      await redis.srem(userRefreshSet(decoded.userId), decoded.jti);
      if (ttl > 0) await redis.set(blacklistKey(decoded.jti), '1', 'EX', ttl);
    }
  } catch {
    // Expired/invalid token — revoke karne layak kuch nahi, ignore karo.
  }
}

/** User ke saare refresh tokens revoke karo (password change / account delete). */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  const jtis = await redis.smembers(userRefreshSet(userId));
  for (const jti of jtis) {
    const ttl = await redis.ttl(refreshKey(jti));
    await redis.del(refreshKey(jti));
    if (ttl > 0) await redis.set(blacklistKey(jti), '1', 'EX', ttl);
  }
  await redis.del(userRefreshSet(userId));
}
