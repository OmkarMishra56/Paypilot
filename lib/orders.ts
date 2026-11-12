import { createHash } from "crypto";
import { prisma } from "./db";
import { cartView, cartToLineItems } from "./cart";
import { createOrder } from "./paypal";
import type { OrderView } from "./types";

export function toOrderView(o: any): OrderView {
  return {
    id: o.id, paypalOrderId: o.paypalOrderId, status: o.status, currency: o.currency, totalCents: o.totalCents,
    items: JSON.parse(o.itemsJson).map((i: any) => ({ name: i.name, qty: i.qty, unitCents: i.unitCents })),
    captureId: o.captureId, capturedCents: o.capturedCents, refundedCents: o.refundedCents,
    invoiceId: o.invoiceId ?? null, invoiceStatus: o.invoiceStatus ?? null,
  };
}

export async function getLatestOrder(sessionId: string): Promise<OrderView | null> {
  const o = await prisma.order.findFirst({ where: { sessionId }, orderBy: { createdAt: "desc" } });
  return o ? toOrderView(o) : null;
}

/** Cart -> PayPal Orders v2 order (intent CAPTURE). Does NOT move money: capture happens later, after UI confirmation. */
export async function createOrderFromCart(sessionId: string): Promise<{ order: OrderView; reused: boolean }> {
  const cart = await cartView(sessionId);
  if (!cart.items.length) throw new Error("The cart is empty.");
  const itemsJson = JSON.stringify(cart.items.map((l) => ({ productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty })));

  const open = await prisma.order.findFirst({
    where: { sessionId, itemsJson, status: { in: ["CREATED", "APPROVED"] } }, orderBy: { createdAt: "desc" },
  });
  if (open) return { order: toOrderView(open), reused: true };

  const prior = await prisma.order.count({ where: { sessionId } });
  const requestId = "po-" + createHash("sha256").update(`${sessionId}|${itemsJson}|${prior}`).digest("hex").slice(0, 32);
  const pp = await createOrder(cartToLineItems(cart), "USD", requestId);

  const row = await prisma.order.create({
    data: { sessionId, paypalOrderId: pp.id, status: "CREATED", currency: "USD", totalCents: cart.totalCents, itemsJson },
  });
  await prisma.event.create({ data: { orderId: row.id, type: "ORDER_CREATED", source: "tool", payloadJson: JSON.stringify({ paypalOrderId: pp.id, status: pp.status }) } });
  return { order: toOrderView(row), reused: false };
}

/**
 * Records one refund exactly once (keyed by PayPal refund id) and recomputes order status.
 * Used by both the refund tool and the webhook, so a refund is never counted twice.
 */
export async function recordRefund(orderId: string, refundId: string, cents: number, source: string, reason?: string): Promise<boolean> {
  const dup = await prisma.event.findFirst({ where: { orderId, type: "REFUND_RECORDED", payloadJson: { contains: `"refundId":"${refundId}"` } } });
  if (dup) return false;
  const o = await prisma.order.findFirst({ where: { id: orderId } });
  if (!o) return false;
  const refunded = o.refundedCents + cents;
  const basis = o.capturedCents || o.totalCents;
  await prisma.order.update({ where: { id: orderId }, data: { refundedCents: refunded, status: refunded >= basis ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
  await prisma.event.create({ data: { orderId, type: "REFUND_RECORDED", source, payloadJson: JSON.stringify({ refundId, cents, ...(reason ? { reason: reason.slice(0, 255) } : {}) }) } });
  return true;
}
