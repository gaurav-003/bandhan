// Zod validation helper — body/query/params validate karo, galat ho to 400.
import { Request, Response, NextFunction } from 'express';
import { z, ZodType } from 'zod';

type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodType, source: Source = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const data = source === 'body' ? req.body : source === 'query' ? req.query : req.params;
    const result = schema.safeParse(data);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    // Validated + coerced data wapas req me daal do (query/params ke liye alag key).
    if (source === 'body') req.body = result.data;
    else if (source === 'query') (req as unknown as { validatedQuery: unknown }).validatedQuery = result.data;
    else (req as unknown as { validatedParams: unknown }).validatedParams = result.data;
    next();
  };
}

/** age dob se calculate karta hai (aaj ki date ke hisaab se). */
export function ageFromDob(dob: Date): number {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

/** passwordHash jaisi sensitive fields response se hata do. */
export function publicUser<T extends { passwordHash?: string | null }>(user: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}
