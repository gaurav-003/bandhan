// Photo storage abstraction — STORAGE_PROVIDER env se switch hota hai:
//   local      = dev/testing, files ./uploads me (public serve NAHI hoti —
//                original sirf signed URL endpoint se milta hai)
//   cloudinary = CLOUDINARY_* keys chahiye (upload API, signed delivery URL)
//   supabase   = SUPABASE_URL + SERVICE_KEY chahiye (Storage API, signed URL)
// Keys nahi mili to provider 'local' par gir jata hai aur warning log karta hai.
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export interface UploadedPhoto {
  /** DB me store karne wala URL/reference (original ka — direct public nahi). */
  url: string;
  /** Provider key (Cloudinary public_id / Supabase path / local filename). */
  storageKey: string;
  /** Free users ko dikhne wala blurred thumbnail URL. */
  blurUrl: string;
}

export type StorageProvider = 'local' | 'cloudinary' | 'supabase';

export function getStorageProvider(): StorageProvider {
  const p = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  if (p === 'cloudinary' && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    return 'cloudinary';
  }
  if (p === 'supabase' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    return 'supabase';
  }
  if (p !== 'local') {
    console.warn(`[storage] ${p} ki keys nahi mili — 'local' provider use ho raha hai. Production me keys set karo.`);
  }
  return 'local';
}

// ---- Local provider ----
async function localUpload(original: Buffer, blur: Buffer, keyBase: string): Promise<UploadedPhoto> {
  const filename = `${keyBase}.jpg`;
  const blurFilename = `${keyBase}-blur.jpg`;
  await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), original);
  await fs.promises.writeFile(path.join(UPLOADS_DIR, blurFilename), blur);
  return {
    url: `local:${filename}`,
    storageKey: filename,
    blurUrl: `/api/photos/thumb/${blurFilename}`,
  };
}

async function localDelete(storageKey: string): Promise<void> {
  for (const name of [storageKey, `${storageKey.replace(/\.jpg$/, '')}-blur.jpg`]) {
    try {
      await fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(name)));
    } catch {
      // File pehle se nahi hai — ignore karo.
    }
  }
}

export function localFilePath(filename: string): string {
  return path.join(UPLOADS_DIR, path.basename(filename));
}

// ---- Cloudinary provider (REST API, koi SDK nahi chahiye) ----
function cloudinarySignature(params: Record<string, string>, secret: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(sorted + secret).digest('hex');
}

async function cloudinaryUpload(buffer: Buffer, keyBase: string, isBlur: boolean): Promise<{ url: string; publicId: string }> {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME as string;
  const apiKey = process.env.CLOUDINARY_API_KEY as string;
  const secret = process.env.CLOUDINARY_API_SECRET as string;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const publicId = isBlur ? `${keyBase}-blur` : keyBase;
  const signature = cloudinarySignature({ public_id: publicId, timestamp }, secret);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' }), `${publicId}.jpg`);
  form.append('public_id', publicId);
  form.append('timestamp', timestamp);
  form.append('api_key', apiKey);
  form.append('signature', signature);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Cloudinary upload fail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { secure_url: string; public_id: string };
  return { url: data.secure_url, publicId: data.public_id };
}

async function cloudinaryDelete(publicId: string): Promise<void> {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME as string;
  const apiKey = process.env.CLOUDINARY_API_KEY as string;
  const secret = process.env.CLOUDINARY_API_SECRET as string;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = cloudinarySignature({ public_id: publicId, timestamp }, secret);
  const form = new FormData();
  form.append('public_id', publicId);
  form.append('timestamp', timestamp);
  form.append('api_key', apiKey);
  form.append('signature', signature);
  await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/destroy`, { method: 'POST', body: form });
}

/** Cloudinary signed delivery URL (5 min expiry). */
export function cloudinarySignedUrl(publicId: string, expiresInSeconds = 300): string {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME as string;
  const secret = process.env.CLOUDINARY_API_SECRET as string;
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  // Signed URL: s--<sig>-- jahan sig = base64url(sha1(public_id + secret)) — NOTE:
  // asli keys milne par production se pehle ek live URL se verify karna.
  const sig = crypto
    .createHash('sha1')
    .update(`${publicId}${secret}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 8);
  return `https://res.cloudinary.com/${cloud}/image/upload/s--${sig}--/fl_attachment/${publicId}?exp=${exp}`;
}

// ---- Supabase Storage provider ----
async function supabaseUpload(buffer: Buffer, filePath: string): Promise<string> {
  const base = (process.env.SUPABASE_URL as string).replace(/\/$/, '');
  const bucket = process.env.SUPABASE_BUCKET || 'bandhan-photos';
  const res = await fetch(`${base}/storage/v1/object/${bucket}/${filePath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true',
    },
    body: new Uint8Array(buffer),
  });
  if (!res.ok) throw new Error(`Supabase upload fail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return filePath;
}

async function supabaseDelete(filePath: string): Promise<void> {
  const base = (process.env.SUPABASE_URL as string).replace(/\/$/, '');
  const bucket = process.env.SUPABASE_BUCKET || 'bandhan-photos';
  await fetch(`${base}/storage/v1/object/${bucket}/${filePath}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
  });
}

async function supabaseSignedUrl(filePath: string, expiresInSeconds = 300): Promise<string> {
  const base = (process.env.SUPABASE_URL as string).replace(/\/$/, '');
  const bucket = process.env.SUPABASE_BUCKET || 'bandhan-photos';
  const res = await fetch(`${base}/storage/v1/object/sign/${bucket}/${filePath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!res.ok) throw new Error(`Supabase signed URL fail ${res.status}`);
  const data = (await res.json()) as { signedURL: string };
  return `${base}${data.signedURL}`;
}

// ---- Public API ----
export async function uploadPhoto(
  original: Buffer,
  blur: Buffer,
  keyBase: string,
): Promise<UploadedPhoto> {
  const provider = getStorageProvider();
  if (provider === 'cloudinary') {
    const [orig, bl] = await Promise.all([
      cloudinaryUpload(original, keyBase, false),
      cloudinaryUpload(blur, keyBase, true),
    ]);
    return { url: orig.url, storageKey: orig.publicId, blurUrl: bl.url };
  }
  if (provider === 'supabase') {
    const origPath = await supabaseUpload(original, `${keyBase}.jpg`);
    const blurPath = await supabaseUpload(blur, `${keyBase}-blur.jpg`);
    const base = (process.env.SUPABASE_URL as string).replace(/\/$/, '');
    const bucket = process.env.SUPABASE_BUCKET || 'bandhan-photos';
    return {
      url: `supabase:${origPath}`,
      storageKey: origPath,
      blurUrl: `${base}/storage/v1/object/public/${bucket}/${blurPath}`,
    };
  }
  return localUpload(original, blur, keyBase);
}

export async function deletePhoto(storageKey: string | null): Promise<void> {
  if (!storageKey) return;
  const provider = getStorageProvider();
  try {
    if (provider === 'cloudinary') {
      await Promise.all([
        cloudinaryDelete(storageKey),
        cloudinaryDelete(`${storageKey}-blur`),
      ]);
    } else if (provider === 'supabase') {
      await Promise.all([
        supabaseDelete(storageKey),
        supabaseDelete(storageKey.replace(/\.jpg$/, '-blur.jpg')),
      ]);
    } else {
      await localDelete(storageKey);
    }
  } catch (err) {
    console.error('[storage] delete fail:', (err as Error).message);
  }
}

/** Viewer ke liye original photo ka signed URL (5 min expiry). */
export async function signedPhotoUrl(photo: { id: string; url: string; storageKey: string | null }): Promise<string> {
  const provider = getStorageProvider();
  if (provider === 'cloudinary' && photo.storageKey) {
    return cloudinarySignedUrl(photo.storageKey, 300);
  }
  if (provider === 'supabase' && photo.storageKey) {
    return supabaseSignedUrl(photo.storageKey, 300);
  }
  // Local: HMAC-signed endpoint URL — /api/photos/:id/file?sig=...&exp=...
  const secret = process.env.JWT_SECRET as string;
  const exp = Math.floor(Date.now() / 1000) + 300;
  const sig = crypto.createHmac('sha256', secret).update(`${photo.id}:${exp}`).digest('hex');
  return `/api/photos/${photo.id}/file?sig=${sig}&exp=${exp}`;
}

/** Local signed file URL verify karo. */
export function verifyPhotoSig(photoId: string, sig: string, exp: string): boolean {
  const secret = process.env.JWT_SECRET as string;
  const expNum = Number(exp);
  if (!expNum || expNum < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${photoId}:${expNum}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}
