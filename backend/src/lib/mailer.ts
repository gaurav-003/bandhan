// Mailer — purana Nodemailer/Gmail wala code hata diya gaya hai.
// Ab sirf mail.ts (provider abstraction) use hota hai. Ye file sirf
// backward-compat re-export hai.
export { sendMail, sendConfirmationEmail, getMailProvider } from './mail';
export type { MailMessage, MailResult } from './mail';
