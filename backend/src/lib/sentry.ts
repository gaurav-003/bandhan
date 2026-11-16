// Sentry — SENTRY_DSN set hone par hi init hota hai, warna no-op.
// @sentry/node dynamic import hai, taaki DSN na ho to bhi server chale.
let sentry: typeof import('@sentry/node') | null = null;

export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    sentry = await import('@sentry/node');
    sentry.init({ dsn, tracesSampleRate: 0.1 });
    console.log('[sentry] enabled');
  } catch (err) {
    console.error('[sentry] init fail:', (err as Error).message);
  }
}

export function captureError(err: unknown): void {
  if (sentry) sentry.captureException(err);
  else console.error('[error]', err);
}
