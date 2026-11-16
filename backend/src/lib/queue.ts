// Background jobs — BullMQ + Redis.
// Queues: mail (confirmation / reminder mails, 3 retries), reminders
// (subscription expiry — roz subah 9 baje repeatable job).
// Worker start karna optional hai: index.ts se startWorkers() call hota hai.
import { Queue, Worker, JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from './prisma';
import { sendMail } from './mail';

const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});
connection.on('error', (err) => console.error('[queue:redis] error:', err.message));

export const mailQueue = new Queue('bandhan-mail', { connection });
export const reminderQueue = new Queue('bandhan-reminders', { connection });

const defaultJobOpts: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 100,
};

export async function enqueueMail(job: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  await mailQueue.add('send', job, defaultJobOpts);
}

export async function scheduleDailyReminders(): Promise<void> {
  // BullMQ v6: repeatable job Queue.add se nahi, upsertJobScheduler se banta hai.
  await reminderQueue.upsertJobScheduler(
    'subscription-expiry-daily',
    { pattern: '0 9 * * *' },
    { name: 'subscription-expiry', data: {}, opts: defaultJobOpts },
  );
}

let workersStarted = false;

export function startWorkers(): void {
  if (workersStarted) return;
  workersStarted = true;

  const mailWorker = new Worker(
    'bandhan-mail',
    async (job) => {
      const result = await sendMail(job.data as { to: string; subject: string; text: string; html: string });
      if (!result.ok) throw new Error(result.error || 'Mail send fail');
    },
    { connection },
  );
  mailWorker.on('failed', (job, err) => {
    console.error(`[queue:mail] job ${job?.id} fail:`, err.message);
  });

  const reminderWorker = new Worker(
    'bandhan-reminders',
    async () => {
      // 3 din me expire hone wali active subscriptions — reminder mail.
      const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const subs = await prisma.subscription.findMany({
        where: { status: 'ACTIVE', endsAt: { lte: soon, gt: new Date() } },
        include: { user: true, package: true },
      });
      for (const sub of subs) {
        await enqueueMail({
          to: sub.user.email,
          subject: 'Your Bandhan subscription is expiring soon',
          text: `Hi, your ${sub.package.name} subscription expires on ${sub.endsAt.toDateString()}. Renew it on Bandhan to keep seeing matches.\n\n— Team Bandhan`,
          html: `<p>Hi,</p><p>Your <b>${sub.package.name}</b> subscription expires on <b>${sub.endsAt.toDateString()}</b>. Renew it on Bandhan to keep seeing matches.</p><p>— Team Bandhan</p>`,
        });
      }
      console.log(`[queue:reminders] ${subs.length} expiry reminders queued`);
    },
    { connection },
  );
  reminderWorker.on('failed', (job, err) => {
    console.error(`[queue:reminders] job ${job?.id} fail:`, err.message);
  });

  console.log('[queue] workers started (mail + reminders)');
}
