// Email sender (nodemailer) — Bandhan email confirmation.
// Config .env se aata hai: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
// Agar SMTP_* set nahi hain to Ethereal test account use hota hai (TESTING ONLY):
// email asal me kisi ko nahi jata, sirf Ethereal preview URL console pe milta hai.
// Production me real SMTP (jaise Gmail app password) lagana zaroori hai.
import nodemailer from 'nodemailer';

type MailTransporter = ReturnType<typeof nodemailer.createTransport>;

let transporter: MailTransporter | null = null;
let etherealUsed = false;

async function getTransporter(): Promise<MailTransporter | null> {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    return transporter;
  }

  // SMTP nahi hai — Ethereal test account try karo.
  try {
    const testAccount = await nodemailer.createTestAccount();
    etherealUsed = true;
    console.log('[mailer] SMTP_* set nahi hain — Ethereal TEST account use ho raha hai (email asal me nahi jayega).');
    console.log(`[mailer] Ethereal inbox: https://ethereal.email/login — user: ${testAccount.user}`);
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    return transporter;
  } catch (err) {
    // Ethereal bhi nahi bana (network/proxy issue) — email skip, console pe link log karo.
    console.error('[mailer] Ethereal test account nahi bana:', (err as Error).message);
    console.error('[mailer] Email NAHI bheja ja sakta — dev mode me confirm URL console/response se lo.');
    return null;
  }
}

/**
 * Confirmation email bhejta hai. Return karta hai Ethereal preview URL
 * (agar Ethereal use hua to) ya null. Agar koi transporter nahi bana to
 * email skip ho jata hai aur null return hota hai — flow phir bhi chalta hai.
 */
export async function sendConfirmationEmail(to: string, confirmUrl: string): Promise<string | null> {
  const mailer = await getTransporter();
  const from = process.env.SMTP_FROM || 'Bandhan <noreply@bandhan.app>';

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

  if (!mailer) {
    console.log(`[mailer] EMAIL SKIPPED (koi transporter nahi) — to: ${to}, confirm URL: ${confirmUrl}`);
    return null;
  }

  const info = await mailer.sendMail({ from, to, subject: 'Confirm your Bandhan account', text, html });
  const previewUrl = nodemailer.getTestMessageUrl(info) || null;
  if (previewUrl) {
    console.log(`[mailer] Confirmation email bheja (Ethereal preview): ${previewUrl}`);
  } else {
    console.log(`[mailer] Confirmation email bheja to ${to} (messageId: ${info.messageId})`);
  }
  return previewUrl;
}

export function isEthereal(): boolean {
  return etherealUsed;
}
