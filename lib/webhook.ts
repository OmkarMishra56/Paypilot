import { prisma } from "./db";
import { toOrderView, recordRefund } from "./orders";
import { publish } from "./sse";
import { toCents } from "./money";

export interface WebhookEvent { id: string; event_type: string; resource: any; create_time?: string }
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

async function note(orderId: string | null, ev: WebhookEvent, summary: string) {
  await prisma.event.create({ data: { orderId, type: ev.event_type, source: "webhook", payloadJson: JSON.stringify({ eventId: ev.id, summary }) } });
}
async function push(order: any, text: string) {
  publish(order.sessionId, { type: "status", text, order: toOrderView(order) });
}

/** Idempotent: safe to run twice for the same event. Out-of-order delivery never downgrades an order. */
export async function processWebhookEvent(ev: WebhookEvent): Promise<{ handled: boolean; orderId?: string }> {
  const r = ev.resource ?? {};
  switch (ev.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED": {
      const ppOrder = r.supplementary_data?.related_ids?.order_id;
      let o = ppOrder ? await prisma.order.findFirst({ where: { paypalOrderId: ppOrder } }) : null;
      if (!o) o = await prisma.order.findFirst({ where: { captureId: r.id } });
      if (!o) { await note(null, ev, `capture ${r.id} for unknown order`); return { handled: false }; }
      const cents = toCents(r.amount?.value ?? 0);
      if (o.status === "CREATED" || o.status === "APPROVED") {
        o = await prisma.order.update({ where: { id: o.id }, data: { status: "CAPTURED", captureId: r.id, capturedCents: cents } });
      } else if (!o.captureId) {
        o = await prisma.order.update({ where: { id: o.id }, data: { captureId: r.id, capturedCents: cents } });
      }
      await note(o.id, ev, `capture ${r.id} completed ${usd(cents)}`);
      await push(o, `PayPal confirmed the payment: ${usd(cents)} captured.`);
      return { handled: true, orderId: o.id };
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      const up: string = (r.links ?? []).find((l: any) => l.rel === "up")?.href ?? "";
      const capId = up.split("/captures/")[1]?.split(/[/?]/)[0];
      const found = capId ? await prisma.order.findFirst({ where: { captureId: capId } }) : null;
      if (!found) { await note(null, ev, `refund ${r.id} for unknown capture`); return { handled: false }; }
      const cents = toCents(r.amount?.value ?? 0);
      await recordRefund(found.id, r.id, cents, "webhook", typeof r.note_to_payer === "string" ? r.note_to_payer : undefined);
      const o = await prisma.order.findFirst({ where: { id: found.id } });
      await note(found.id, ev, `refund ${r.id} ${usd(cents)}`);
      await push(o, `PayPal confirmed a refund of ${usd(cents)}.`);
      return { handled: true, orderId: found.id };
    }
    case "INVOICING.INVOICE.PAID": {
      const inv = r.invoice ?? r;
      const found = inv.id ? await prisma.order.findFirst({ where: { invoiceId: inv.id } }) : null;
      if (!found) { await note(null, ev, `invoice ${inv.id} for unknown order`); return { handled: false }; }
      const o = await prisma.order.update({ where: { id: found.id }, data: { invoiceStatus: "PAID", ...(found.status === "INVOICED" ? { status: "INVOICE_PAID" } : {}) } });
      await note(o.id, ev, `invoice ${inv.id} paid`);
      await push(o, `Invoice ${inv.detail?.invoice_number ?? inv.id} was paid.`);
      return { handled: true, orderId: o.id };
    }
    default:
      await note(null, ev, "ignored event type");
      return { handled: false };
  }
}
