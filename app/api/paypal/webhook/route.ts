import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { verifyWebhookSignature } from "@/lib/paypal";
import { processWebhookEvent, type WebhookEvent } from "@/lib/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text(); // raw bytes: PayPal's signature covers them exactly
  let event: WebhookEvent;
  try { event = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!event?.id || !event?.event_type) return Response.json({ error: "Not a PayPal event" }, { status: 400 });
  if (!process.env.PAYPAL_WEBHOOK_ID) return Response.json({ error: "PAYPAL_WEBHOOK_ID is not configured" }, { status: 500 });

  let verified = false;
  try { verified = await verifyWebhookSignature(req.headers, raw); }
  catch (e) {
    // PayPal rejected the verification request itself (missing/malformed signature headers): treat as unverified, don't invite retries.
    const err = e as { name?: string; status?: number };
    // name/status check (not instanceof): survives duplicated module instances in dev bundlers
    if (!(err?.name === "PayPalError" && (err.status === 400 || err.status === 422))) {
      console.error("[webhook] verification call failed", e);
      return Response.json({ error: "Could not verify" }, { status: 500 }); // our side / PayPal outage => 5xx so PayPal retries
    }
  }

  if (!verified) {
    await prisma.webhookLog.create({ data: { eventId: `unverified-${randomUUID()}`, eventType: event.event_type, verified: false, payloadJson: raw.slice(0, 20000) } });
    return Response.json({ error: "Signature verification failed" }, { status: 400 });
  }
  if (await prisma.webhookLog.findUnique({ where: { eventId: event.id } })) return Response.json({ ok: true, duplicate: true });

  try {
    const r = await processWebhookEvent(event);
    await prisma.webhookLog.create({ data: { eventId: event.id, eventType: event.event_type, verified: true, payloadJson: raw.slice(0, 20000) } });
    return Response.json({ ok: true, handled: r.handled });
  } catch (e) {
    console.error("[webhook] processing failed", e);
    return Response.json({ error: "Processing failed" }, { status: 500 }); // not logged => PayPal's retry will be processed
  }
}
