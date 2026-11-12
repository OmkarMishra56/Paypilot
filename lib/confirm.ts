/**
 * THE guardrail. Money-moving PayPal calls (capture / invoice / refund) are only reachable from here,
 * and only through confirmAction(), which needs a one-time token that:
 *   - was created server-side by a propose*() call (the agent can only ever PROPOSE),
 *   - belongs to the same session, is still pending and unexpired,
 *   - is atomically consumed before anything runs (no double-spend on double click / replay).
 * What gets executed is read from the DB row (and re-validated against live data), never from the client.
 */
import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "./db";
import { captureOrder, refundCapture, createInvoiceDraft, sendInvoice, type LineItem } from "./paypal";
import { toOrderView, recordRefund } from "./orders";
import { getProduct } from "./catalog";
import { publish } from "./sse";
import type { ConfirmationView, OrderView } from "./types";

export class ConfirmationError extends Error {}
export type Action = ConfirmationView["action"];
const TTL_MS = 10 * 60 * 1000;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const Email = z.string().email().max(254);
export const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, "$1***$2");

interface Payload {
  orderId?: string; amountCents: number; currency: string; items: ConfirmationView["items"]; title: string; detail?: string;
  refund?: { captureId: string; reason: string };
  invoice?: { recipientEmail: string; note: string; lines: { productId: string; qty: number }[] };
}
type Handler = (sessionId: string, p: Payload, token: string) => Promise<{ order: OrderView; message: string }>;

async function log(sessionId: string, name: string, ok: boolean, summary: string) {
  try { await prisma.toolLog.create({ data: { sessionId, kind: "tool", name, ok, summary: summary.slice(0, 300) } }); } catch { /* best-effort */ }
}

function toView(row: any): ConfirmationView {
  const p = JSON.parse(row.payloadJson) as Payload;
  return { token: row.id, action: row.action, title: p.title, amountCents: p.amountCents, currency: p.currency, items: p.items, detail: p.detail, expiresAt: new Date(row.expiresAt).toISOString() };
}

async function propose(sessionId: string, action: Action, payload: Payload): Promise<ConfirmationView> {
  const payloadJson = JSON.stringify(payload);
  const existing = await prisma.confirmation.findFirst({ where: { sessionId, action, status: "pending", payloadJson, expiresAt: { gt: new Date() } } });
  if (existing) return toView(existing);
  const row = await prisma.confirmation.create({ data: { id: randomUUID(), sessionId, action, payloadJson, expiresAt: new Date(Date.now() + TTL_MS) } });
  await log(sessionId, `confirm:${action}:proposed`, true, `awaiting user confirmation for ${usd(payload.amountCents)} ${payload.currency}`);
  return toView(row);
}

// ---------------------------------------------------------------- proposals (never touch PayPal)

/** Opens a pending "capture payment" confirmation. */
export async function proposeCapture(sessionId: string, orderRowId: string): Promise<ConfirmationView> {
  const o = await prisma.order.findFirst({ where: { id: orderRowId, sessionId } });
  if (!o) throw new ConfirmationError("Order not found.");
  if (o.status !== "APPROVED") throw new ConfirmationError("This order has not been approved in PayPal yet.");
  return propose(sessionId, "capture", { orderId: o.id, amountCents: o.totalCents, currency: o.currency, items: toOrderView(o).items, title: "Confirm payment" });
}

/** Opens a pending "send invoice" confirmation. Prices come from the server catalog, never from the model. */
export async function proposeInvoice(sessionId: string, input: { recipientEmail: string; note?: string; lines: { productId: string; qty: number }[] }): Promise<ConfirmationView> {
  const email = Email.safeParse(input.recipientEmail.trim());
  if (!email.success) throw new ConfirmationError("That does not look like a valid email address.");
  if (!input.lines.length) throw new ConfirmationError("There is nothing to bill.");
  const items = input.lines.map((l) => {
    const p = getProduct(l.productId);
    if (!p) throw new ConfirmationError(`Unknown product_id "${l.productId}".`);
    return { name: p.name, qty: l.qty, unitCents: p.priceCents };
  });
  const amountCents = items.reduce((s, i) => s + i.unitCents * i.qty, 0);
  const note = (input.note ?? "").trim().slice(0, 500);
  return propose(sessionId, "invoice", {
    amountCents, currency: "USD", items, title: "Confirm invoice",
    detail: `Will be emailed to ${email.data}${note ? `. Note: ${note}` : ""}`,
    invoice: { recipientEmail: email.data, note, lines: input.lines },
  });
}

/** Opens a pending "refund" confirmation. The cap (captured minus already refunded) is enforced here AND again at execution. */
export async function proposeRefund(sessionId: string, input: { captureId: string; amountCents?: number; reason: string }): Promise<ConfirmationView> {
  const o = await prisma.order.findFirst({ where: { sessionId, captureId: input.captureId } });
  if (!o) throw new ConfirmationError("No paid order with that capture id was found in this session.");
  if (o.status !== "CAPTURED" && o.status !== "PARTIALLY_REFUNDED") throw new ConfirmationError("This order is not in a refundable state.");
  const remaining = o.capturedCents - o.refundedCents;
  if (remaining <= 0) throw new ConfirmationError("This order has already been fully refunded.");
  const amountCents = input.amountCents ?? remaining;
  if (amountCents <= 0) throw new ConfirmationError("The refund amount must be positive.");
  if (amountCents > remaining) throw new ConfirmationError(`The most that can still be refunded is ${usd(remaining)}.`);
  return propose(sessionId, "refund", {
    orderId: o.id, amountCents, currency: o.currency, items: toOrderView(o).items, title: "Confirm refund",
    detail: `Reason: ${input.reason}`, refund: { captureId: input.captureId, reason: input.reason },
  });
}

export async function getPendingConfirmation(sessionId: string): Promise<ConfirmationView | null> {
  const row = await prisma.confirmation.findFirst({ where: { sessionId, status: "pending", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  return row ? toView(row) : null;
}

export async function cancelConfirmation(sessionId: string, token: string) {
  const r = await prisma.confirmation.updateMany({ where: { id: token, sessionId, status: "pending" }, data: { status: "cancelled" } });
  if (r.count === 1) await log(sessionId, "confirm:cancelled", true, "user declined");
}

// ---------------------------------------------------------------- execution (only reachable via confirmAction)

const handlers: Record<Action, Handler> = {
  capture: async (sessionId, p, token) => {
    const o = await prisma.order.findFirst({ where: { id: p.orderId, sessionId } });
    if (!o || !o.paypalOrderId) throw new ConfirmationError("Order not found.");
    if (o.status === "CAPTURED") return { order: toOrderView(o), message: "This order was already paid." };
    if (o.status !== "APPROVED") throw new ConfirmationError("This order is not ready to be captured.");
    // Amount shown in the modal and amount captured both come from the DB order, never from the client.
    const cap = await captureOrder(o.paypalOrderId, `cap-${token}`);
    if (cap.status !== "COMPLETED" || !cap.captureId) throw new ConfirmationError(`PayPal returned capture status ${cap.status}. Nothing was marked as paid.`);
    const updated = await prisma.order.update({ where: { id: o.id }, data: { status: "CAPTURED", captureId: cap.captureId, capturedCents: cap.capturedCents } });
    await prisma.event.create({ data: { orderId: o.id, type: "PAYMENT_CAPTURED", source: "user_confirmed", payloadJson: JSON.stringify({ captureId: cap.captureId, capturedCents: cap.capturedCents, expectedCents: o.totalCents }) } });
    return { order: toOrderView(updated), message: `Payment of ${usd(cap.capturedCents)} captured.` };
  },

  refund: async (sessionId, p, token) => {
    const o = await prisma.order.findFirst({ where: { id: p.orderId, sessionId } });
    if (!o || !o.captureId || !p.refund) throw new ConfirmationError("Order not found.");
    if (o.status !== "CAPTURED" && o.status !== "PARTIALLY_REFUNDED") throw new ConfirmationError("This order is not in a refundable state.");
    const remaining = o.capturedCents - o.refundedCents; // re-checked against live data, not the proposal
    if (p.amountCents > remaining) throw new ConfirmationError(`Only ${usd(remaining)} can still be refunded on this order.`);
    const rf = await refundCapture(o.captureId, p.amountCents, o.currency as "USD", p.refund.reason, `rf-${token}`);
    if (rf.status === "FAILED" || rf.status === "CANCELLED") throw new ConfirmationError(`PayPal reported the refund as ${rf.status}. Nothing was refunded.`);
    await recordRefund(o.id, rf.refundId, p.amountCents, "user_confirmed", p.refund.reason); // idempotent by refund id, so the webhook can't double count
    const fresh = await prisma.order.findFirst({ where: { id: o.id } });
    return { order: toOrderView(fresh), message: `Refunded ${usd(p.amountCents)}.` };
  },

  invoice: async (sessionId, p, token) => {
    const inv = p.invoice;
    if (!inv) throw new ConfirmationError("Invalid invoice confirmation.");
    // Rebuild from the catalog at execution time: if prices moved since the dialog was shown, stop.
    const lines: (LineItem & { productId: string })[] = inv.lines.map((l) => {
      const prod = getProduct(l.productId);
      if (!prod) throw new ConfirmationError(`Unknown product_id "${l.productId}".`);
      return { productId: prod.id, name: prod.name, sku: prod.id, unitCents: prod.priceCents, qty: l.qty };
    });
    const total = lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
    if (total !== p.amountCents) throw new ConfirmationError("Prices changed since you were asked to confirm. Please start again.");

    // Resume support: if a previous attempt created the draft but failed to send, reuse it instead of creating a second invoice.
    const drafted = await prisma.event.findFirst({ where: { type: "INVOICE_DRAFTED", payloadJson: { contains: `"token":"${token}"` } } });
    let invoiceId: string, invoiceNumber: string;
    if (drafted) ({ invoiceId, invoiceNumber } = JSON.parse(drafted.payloadJson));
    else {
      ({ invoiceId, invoiceNumber } = await createInvoiceDraft(inv.recipientEmail, lines, inv.note, "USD", `inv-${token}`));
      await prisma.event.create({ data: { orderId: null, type: "INVOICE_DRAFTED", source: "user_confirmed", payloadJson: JSON.stringify({ token, invoiceId, invoiceNumber }) } });
    }
    let order = await prisma.order.findFirst({ where: { sessionId, invoiceId } });
    if (!order) {
      order = await prisma.order.create({ data: {
        sessionId, status: "INVOICE_DRAFT", currency: "USD", totalCents: total, invoiceId, invoiceStatus: "DRAFT",
        itemsJson: JSON.stringify(lines.map((l) => ({ productId: l.productId, name: l.name, unitCents: l.unitCents, qty: l.qty }))),
      } });
    }
    await sendInvoice(invoiceId, inv.note, `inv-${token}-send`);
    order = await prisma.order.update({ where: { id: order.id }, data: { status: "INVOICED", invoiceStatus: "SENT" } });
    await prisma.event.create({ data: { orderId: order.id, type: "INVOICE_SENT", source: "user_confirmed", payloadJson: JSON.stringify({ invoiceId, invoiceNumber, to: maskEmail(inv.recipientEmail), totalCents: total }) } });
    return { order: toOrderView(order), message: `Invoice ${invoiceNumber} for ${usd(total)} sent to ${maskEmail(inv.recipientEmail)}.` };
  },
};

/** The only way to run a money-moving action. */
export async function confirmAction(sessionId: string, token: string) {
  const claimed = await prisma.confirmation.updateMany({
    where: { id: token, sessionId, status: "pending", expiresAt: { gt: new Date() } }, data: { status: "used" },
  });
  if (claimed.count !== 1) throw new ConfirmationError("This confirmation is invalid, expired or was already used.");
  const row = await prisma.confirmation.findUnique({ where: { id: token } });
  const handler = handlers[row.action as Action];
  if (!handler) { await prisma.confirmation.update({ where: { id: token }, data: { status: "pending" } }); throw new ConfirmationError(`Unsupported action: ${row.action}`); }
  try {
    const res = await handler(sessionId, JSON.parse(row.payloadJson), token);
    await log(sessionId, `confirm:${row.action}:executed`, true, res.message);
    publish(sessionId, { type: "status", text: res.message, order: res.order }); // shows up in the chat immediately
    return { action: row.action as Action, ...res };
  } catch (e) {
    // Re-open the token so the user can retry; every PayPal-Request-Id derives from the token, so a retry can't double-charge or double-refund.
    await prisma.confirmation.update({ where: { id: token }, data: { status: "pending" } });
    await log(sessionId, `confirm:${row.action}:failed`, false, e instanceof Error ? e.message : "error");
    throw e;
  }
}
