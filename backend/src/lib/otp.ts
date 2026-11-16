// OTP rules — Redis me:
// - Ek identifier par 1 ghante me max 5 OTP send.
// - Galat OTP max 5 baar, phir 15 min block.
// - Sahi OTP par saare counters clear.
import { redis } from './redis';

const OTP_TTL_SECONDS = 600; // 10 minute
const MAX_SEND_PER_HOUR = 5;
const MAX_WRONG_ATTEMPTS = 5;
const BLOCK_SECONDS = 15 * 60; // 15 minute

function otpKey(id: string): string {
  return `otp:${id.toLowerCase()}`;
}
function sendCountKey(id: string): string {
  return `otp:send:${id.toLowerCase()}`;
}
function attemptsKey(id: string): string {
  return `otp:attempts:${id.toLowerCase()}`;
}
function blockKey(id: string): string {
  return `otp:block:${id.toLowerCase()}`;
}

export async function isOtpBlocked(identifier: string): Promise<boolean> {
  return (await redis.exists(blockKey(identifier))) === 1;
}

/** OTP send karne se pehle call karo — limit cross hui to false. */
export async function checkOtpSendAllowed(identifier: string): Promise<boolean> {
  if (await isOtpBlocked(identifier)) return false;
  const count = await redis.incr(sendCountKey(identifier));
  if (count === 1) await redis.expire(sendCountKey(identifier), 60 * 60);
  return count <= MAX_SEND_PER_HOUR;
}

export async function storeOtp(identifier: string, otp: string): Promise<void> {
  await redis.set(otpKey(identifier), otp, 'EX', OTP_TTL_SECONDS);
  await redis.del(attemptsKey(identifier));
}

export type OtpCheck = 'ok' | 'invalid' | 'blocked' | 'expired';

export async function checkOtp(identifier: string, otp: string): Promise<OtpCheck> {
  if (await isOtpBlocked(identifier)) return 'blocked';
  const stored = await redis.get(otpKey(identifier));
  if (!stored) return 'expired';
  if (stored !== otp) {
    const attempts = await redis.incr(attemptsKey(identifier));
    if (attempts === 1) await redis.expire(attemptsKey(identifier), OTP_TTL_SECONDS);
    if (attempts >= MAX_WRONG_ATTEMPTS) {
      await redis.set(blockKey(identifier), '1', 'EX', BLOCK_SECONDS);
      await redis.del(otpKey(identifier));
      await redis.del(attemptsKey(identifier));
      return 'blocked';
    }
    return 'invalid';
  }
  // Sahi OTP — sab clear karo.
  await redis.del(otpKey(identifier));
  await redis.del(attemptsKey(identifier));
  await redis.del(sendCountKey(identifier));
  return 'ok';
}
