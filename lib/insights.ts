import { prisma } from "./db";
import { redact } from "./paypal";
import { fromCents } from "./money";
import { toOrderView } from "./orders";

const LABEL: Record<string, string> = {
  ORDER_CREATED: "Checkout order created",
  ORDER_APPROVED: "Buyer approved the order in PayPal",
  PAYMENT_CAPTURED: "Payment captured after the user confirmed",
  REFUND_RECORDED: "Refund recorded",
  INVOICE_SENT: "Invoice sent",
  "PAYMENT.CAPTURE.COMPLETED": "PayPal webhook: capture completed",
  "PAYMENT.CAPTURE.REFUNDED": "PayPal webhook: refund completed",
  "INVOICING.INVOICE.PAID": "PayPal webhook: invoice paid",
};
const parse = (s: string): any => { try { return JSON.parse(s); } catch { return {}; } };
const usd = (c: number) => `$${fromCents(c)}`;

function detail(type: string, p: any): string {
  switch (type) {
    case "ORDER_CREATED": return `PayPal order status ${p.status ?? "created"}`;
    case "PAYMENT_CAPTURED": return `${usd(p.capturedCents ?? 0)} captured (order total was ${usd(p.expectedCents ?? 0)})`;
    case "REFUND_RECORDED": return `${usd(p.cents ?? 0)} refunded; ${p.reason ? `reason: "${p.reason}"` : "no reason recorded"}`;
    case "INVOICE_SENT": return `invoice ${p.invoiceNumber ?? ""} to ${p.to ?? "recipient"}, total ${usd(p.totalCents ?? 0)}`;
    default: return p.summary ?? "";
  }
}

/** Facts only: everything the agent may say about an order comes from this DB-backed timeline. */
export async function explainOrder(sessionId: string, ref?: string) {
  let o: any = null;
  if (ref) {
    for (const where of [{ id: ref }, { paypalOrderId: ref }, { captureId: ref }, { invoiceId: ref }]) {
      o = await prisma.order.findFirst({ where: { sessionId, ...where } });
      if (o) break;
    }
  } else {
    o = await prisma.order.findFirst({ where: { sessionId }, orderBy: { createdAt: "desc" } });
  }
  if (!o) return null;

  const events: any[] = await prisma.event.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "asc" } });
  const eventIds = events.map((e) => parse(e.payloadJson).eventId).filter(Boolean);
  const hooks: any[] = eventIds.length ? await prisma.webhookLog.findMany({ where: { eventId: { in: eventIds } } }) : [];

  const view = toOrderView(o);
  const refunds = events.filter((e) => e.type === "REFUND_RECORDED").map((e) => {
    const p = parse(e.payloadJson);
    return { amount: usd(p.cents ?? 0), reason: p.reason ? redact(String(p.reason)) : null, recorded_via: e.source, at: new Date(e.createdAt).toISOString() };
  });

  return {
    order: {
      status: view.status, currency: view.currency, total: usd(view.totalCents),
      items: view.items.map((i) => `${i.qty} x ${i.name}`),
      captured: usd(view.capturedCents), refunded: usd(view.refundedCents),
      still_refundable: usd(Math.max(0, view.capturedCents - view.refundedCents)),
      capture_id: view.captureId, invoice_id: view.invoiceId, invoice_status: view.invoiceStatus,
    },
    timeline: events.map((e) => ({
      at: new Date(e.createdAt).toISOString(), what: LABEL[e.type] ?? e.type, source: e.source,
      detail: redact(detail(e.type, parse(e.payloadJson))),
    })),
    refunds,
    webhooks_received: hooks.map((h) => ({ event: h.eventType, signature_verified: !!h.verified, at: new Date(h.createdAt).toISOString() })),
    note: "These are the only recorded facts. If something is not listed (for example a refund reason), say it is not recorded.",
  };
}
