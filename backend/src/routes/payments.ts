// Payments — Razorpay order create + webhook.
// Webhook: signature verify hota hai (RAZORPAY_WEBHOOK_SECRET se) aur
// same razorpayPaymentId dobara process nahi hota (idempotency).
// Keys nahi hain to create-order 503 deta hai — code ready hai, key chahiye.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import Razorpay from 'razorpay';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { logAudit } from '../lib/audit';

const router = Router();

function getRazorpay(): Razorpay | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

const createOrderSchema = z.object({
  packageId: z.string().min(1, 'packageId chahiye'),
});

router.post('/create-order', requireAuth, validate(createOrderSchema), async (req: Request, res: Response) => {
  const { packageId } = req.body as z.infer<typeof createOrderSchema>;
  try {
    const rz = getRazorpay();
    if (!rz) {
      res.status(503).json({ error: 'Payment abhi setup nahi hai — Razorpay keys chahiye' });
      return;
    }
    const pkg = await prisma.package.findUnique({ where: { id: packageId } });
    if (!pkg) {
      res.status(404).json({ error: 'Package nahi mila' });
      return;
    }
    if (pkg.pricePaise === 0) {
      res.status(400).json({ error: 'Free package ke liye payment nahi chahiye' });
      return;
    }
    const order = await rz.orders.create({
      amount: pkg.pricePaise,
      currency: 'INR',
      receipt: `bandhan_${req.user!.userId.slice(0, 8)}_${Date.now()}`,
    });
    const payment = await prisma.payment.create({
      data: {
        userId: req.user!.userId,
        razorpayOrderId: order.id,
        amountPaise: pkg.pricePaise,
        currency: 'INR',
        status: 'CREATED',
      },
    });
    res.status(201).json({
      orderId: order.id,
      amountPaise: pkg.pricePaise,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
      paymentId: payment.id,
      package: pkg.name,
    });
  } catch (err) {
    console.error('[payments/create-order]', err);
    res.status(500).json({ error: 'Order banane me fail ho gaya' });
  }
});

// Webhook — NOTE: index.ts me is route ke liye express.raw() body parser
// lagta hai (signature verify ke liye raw body chahiye hota hai).
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[payments/webhook] RAZORPAY_WEBHOOK_SECRET set nahi hai');
      res.status(500).json({ error: 'Webhook secret set nahi hai' });
      return;
    }
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string') {
      res.status(400).json({ error: 'Signature missing hai' });
      return;
    }
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: 'Raw body missing hai' });
      return;
    }
    const isValid = Razorpay.validateWebhookSignature(
      rawBody.toString('utf8'),
      signature,
      secret,
    );
    if (!isValid) {
      console.warn('[payments/webhook] invalid signature');
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }
    const event = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      payload: { payment: { entity: { id: string; order_id: string; status: string } } };
    };
    if (event.event !== 'payment.captured') {
      // Sirf successful payment process karo, baaki events ko ack karo.
      res.json({ ok: true, ignored: event.event });
      return;
    }
    const entity = event.payload.payment.entity;
    const razorpayPaymentId = entity.id;

    // Idempotency: ye payment pehle se PAID hai to dobara process mat karo.
    const alreadyPaid = await prisma.payment.findFirst({
      where: { razorpayPaymentId, status: 'PAID' },
    });
    if (alreadyPaid) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: entity.order_id },
    });
    if (!payment) {
      console.error('[payments/webhook] order nahi mila:', entity.order_id);
      res.status(404).json({ error: 'Order nahi mila' });
      return;
    }
    // Payment ke user ka active package nikalo — order ke amount se match karo.
    const pkg = await prisma.package.findFirst({ where: { pricePaise: payment.amountPaise } });
    if (!pkg) {
      console.error('[payments/webhook] package nahi mila amount se:', payment.amountPaise);
      res.status(404).json({ error: 'Package nahi mila' });
      return;
    }
    const endsAt = new Date(Date.now() + pkg.durationDays * 24 * 60 * 60 * 1000);
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: { razorpayPaymentId, status: 'PAID' },
    });
    const subscription = await prisma.subscription.create({
      data: {
        userId: payment.userId,
        packageId: pkg.id,
        status: 'ACTIVE',
        endsAt,
      },
    });
    await prisma.payment.update({
      where: { id: payment.id },
      data: { subscriptionId: subscription.id },
    });
    await logAudit(payment.userId, 'payment', undefined, `payment:${updatedPayment.id} package:${pkg.name}`);
    res.json({ ok: true, subscriptionId: subscription.id });
  } catch (err) {
    console.error('[payments/webhook]', err);
    res.status(500).json({ error: 'Webhook process fail ho gaya' });
  }
});

export default router;
