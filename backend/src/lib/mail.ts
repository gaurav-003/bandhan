// Mail provider abstraction — MAIL_PROVIDER env se switch hota hai:
//   log    = koi key nahi chahiye, mail console pe log hota hai (local dev/testing)
//   brevo  = abhi ke liye ye (BREVO_API_KEY + sender email Brevo me verify karo)
//   resend = domain aane ke baad (RESEND_API_KEY + domain verify karo)
// Purana Gmail SMTP / Nodemailer hata diya gaya hai.
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

type Provider = 'log' | 'brevo' | 'resend';

function getProvider(): Provider {
  const p = (process.env.MAIL_PROVIDER || 'log').toLowerCase();
  if (p === 'brevo' || p === 'resend') return p;
  return 'log';
}

function parseSender(raw: string): { email: string; name: string } {
  const m = raw.match(/^(.*)<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || 'Bandhan', email: m[2].trim() };
  return { name: 'Bandhan', email: raw.trim() };
}

async function sendViaBrevo(msg: MailMessage): Promise<MailResult> {
  const apiKey = process.env.BREVO_API_KEY;
  const senderRaw = process.env.BREVO_SENDER || 'Bandhan <noreply@bandhan.app>';
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY set nahi hai' };
  const sender = parseSender(senderRaw);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: sender.email, name: sender.name },
      to: [{ email: msg.to }],
      subject: msg.subject,
      htmlContent: msg.html,
      textContent: msg.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `Brevo ${res.status}: ${body.slice(0, 200)}` };
  }
  const data = (await res.json().catch(() => ({}))) as { messageId?: string };
  return { ok: true, messageId: data.messageId };
}

async function sendViaResend(msg: MailMessage): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_SENDER || 'Bandhan <noreply@bandhan.app>';
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY set nahi hai' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 200)}` };
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { ok: true, messageId: data.id };
}

export async function sendMail(msg: MailMessage): Promise<MailResult> {
  const provider = getProvider();
  if (provider === 'log') {
    console.log(`[mail:log] to=${msg.to} subject=${msg.subject}`);
    console.log(`[mail:log] body: ${msg.text}`);
    return { ok: true, messageId: 'log' };
  }
  try {
    const result = provider === 'brevo' ? await sendViaBrevo(msg) : await sendViaResend(msg);
    if (!result.ok) console.error(`[mail:${provider}] fail:`, result.error);
    else console.log(`[mail:${provider}] sent to ${msg.to} (messageId: ${result.messageId})`);
    return result;
  } catch (err) {
    const error = (err as Error).message;
    console.error(`[mail:${provider}] error:`, error);
    return { ok: false, error };
  }
}

export function getMailProvider(): Provider {
  return getProvider();
}

/**
 * Confirmation email. messageId return karta hai (ya null agar mail fail/log ho).
 * Purane mailer.ts jaisa signature rakha hai taaki callers na badalne padein.
 */
export async function sendConfirmationEmail(to: string, confirmUrl: string): Promise<string | null> {
  const html = `<!doctype html>
<html><body style="font-family: Georgia, serif; background:#fff8ec; padding:32px; color:#3b1f2b;">
  <div style="max-width:520px; margin:0 auto; background:#ffffff; border:1px solid #e8d5a3; border-radius:16px; padding:32px; text-align:center;">
    <h1 style="color:#8a6d1b; letter-spacing:4px; margin:0 0 4px;">BANDHAN</h1>
    <p style="color:#8a6d1b; letter-spacing:2px; font-size:12px; margin:0 0 24px;">TWO SOULS &middot; ONE STORY</p>
    <h2 style="margin:0 0 12px;">Confirm your email address</h2>
    <p style="line-height:1.6;">Welcome to Bandhan! Please confirm your email address to continue creating your account.</p>
    <a href="${confirmUrl}" style="display:inline-block; background:#c9a227; color:#fff; text-decoration:none; font-weight:bold; padding:14px 32px; border-radius:999px; margin:20px 0;">Confirm my email</a>
    <p style="font-size:13px; color:#7a6a55; line-height:1.6;">This link is valid for <b>24 hours</b>.<br>
    If the button does not work, copy and paste this link in your browser:<br>
    <a href="${confirmUrl}" style="color:#8a6d1b; word-break:break-all;">${confirmUrl}</a></p>
    <p style="font-size:13px; color:#7a6a55;">If you did not create a Bandhan account, please ignore this email.</p>
    <p style="font-size:12px; color:#a08c6a; margin-top:24px;">&mdash; Team Bandhan</p>
  </div>
</body></html>`;

  const text =
    `Welcome to Bandhan!\n\n` +
    `Please confirm your email address by clicking this link (valid for 24 hours):\n${confirmUrl}\n\n` +
    `If you did not create a Bandhan account, please ignore this email.\n\n— Team Bandhan`;

  const result = await sendMail({ to, subject: 'Confirm your Bandhan account', text, html });
  return result.ok ? (result.messageId ?? null) : null;
}
