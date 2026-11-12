import { prisma } from "./db";
import { schemas, type ToolExecutor, type ToolName } from "./tools";
import { searchProducts, getProduct } from "./catalog";
import { addToCart, cartView } from "./cart";
import { createOrderFromCart, getLatestOrder } from "./orders";
import { PayPalError, redact } from "./paypal";
import { proposeCapture, proposeInvoice, proposeRefund } from "./confirm";
import { explainOrder } from "./insights";
import { fromCents, toCents } from "./money";

async function logTool(sessionId: string, name: string, input: unknown, ok: boolean, summary: string) {
  try {
    await prisma.toolLog.create({ data: { sessionId, kind: "tool", name, ok, summary: redact(summary).slice(0, 300), inputJson: redact(JSON.stringify(input ?? {})).slice(0, 2000) } });
  } catch { /* best-effort */ }
}

async function run(name: ToolName, input: any, sessionId: string): Promise<unknown> {
  switch (name) {
    case "search_products": {
      const results = searchProducts(input.query, input.max_price);
      return { count: results.length, products: results };
    }
    case "add_to_cart": {
      const p = getProduct(input.product_id);
      if (!p) throw new Error(`Unknown product_id ${input.product_id}. Use search_products to find valid ids.`);
      return { added: { id: p.id, name: p.name, qty: input.qty }, cart: await addToCart(sessionId, p.id, input.qty) };
    }
    case "view_cart":
      return await cartView(sessionId);
    case "create_paypal_order": {
      const { order, reused } = await createOrderFromCart(sessionId);
      return orderResult(order.paypalOrderId!, order.totalCents, order.items, reused ? "reused" : "created");
    }
    case "capture_paypal_order": {
      const id: string = input.order_id;
      const o = await prisma.order.findFirst({ where: { sessionId, OR: [{ paypalOrderId: id }, { id }] } });
      if (!o) throw new Error(`No order found for ${id} in this session.`);
      if (o.status === "CAPTURED") return { status: "already_captured", message: "This order is already paid." };
      if (o.status !== "APPROVED") throw new Error("The shopper has not approved this order in PayPal yet. Ask them to click the PayPal button in the side panel first.");
      const c = await proposeCapture(sessionId, o.id);
      return { status: "awaiting_user_confirmation", amount: fromCents(c.amountCents), currency: c.currency, message: "A confirmation dialog is now open in the UI. Ask the shopper to review and confirm it. Nothing has been charged yet." };
    }
    case "create_invoice": {
      let lines = input.items?.map((i: any) => ({ productId: i.product_id, qty: i.qty }));
      if (!lines) {
        const cart = await cartView(sessionId);
        if (!cart.items.length) throw new Error("The cart is empty and no items were given to bill.");
        lines = cart.items.map((l) => ({ productId: l.productId, qty: l.qty }));
      }
      const c = await proposeInvoice(sessionId, { recipientEmail: input.recipient_email, note: input.note, lines });
      return { status: "awaiting_user_confirmation", amount: fromCents(c.amountCents), currency: c.currency, recipient: input.recipient_email, message: "A confirmation dialog is now open in the UI. Ask the shopper to review and confirm it. Nothing has been sent yet." };
    }
    case "refund_order": {
      const c = await proposeRefund(sessionId, { captureId: input.capture_id, amountCents: input.amount === undefined ? undefined : toCents(input.amount), reason: input.reason });
      return { status: "awaiting_user_confirmation", amount: fromCents(c.amountCents), currency: c.currency, message: "A confirmation dialog is now open in the UI. Ask the shopper to review and confirm it. Nothing has been refunded yet." };
    }
    case "explain_order": {
      const r = await explainOrder(sessionId, input.order_id);
      if (!r) throw new Error("No matching order in this session.");
      return r;
    }
    case "get_order_status": {
      const id: string = input.order_id;
      const o = await prisma.order.findFirst({ where: { sessionId, OR: [{ paypalOrderId: id }, { id }, { invoiceId: id }] }, include: { events: { orderBy: { createdAt: "desc" }, take: 10 } } });
      if (!o) throw new Error(`No order found for ${id} in this session.`);
      return {
        paypal_order_id: o.paypalOrderId, status: o.status, total: fromCents(o.totalCents), currency: o.currency,
        captured: fromCents(o.capturedCents), refunded: fromCents(o.refundedCents), capture_id: o.captureId, invoice_id: o.invoiceId, invoice_status: o.invoiceStatus,
        recent_events: o.events.map((e: any) => ({ type: e.type, source: e.source, at: e.createdAt })),
      };
    }
  }
}

function orderResult(paypalOrderId: string, totalCents: number, items: unknown, state: string) {
  return {
    state, paypal_order_id: paypalOrderId, total: fromCents(totalCents), currency: "USD", items,
    next: "The PayPal buttons are now showing in the side panel. The shopper approves the payment there.",
  };
}

export const executeTool: ToolExecutor = async (name, rawInput, ctx) => {
  if (!(name in schemas)) return { ok: false, error: `Unknown tool: ${name}` };
  const parsed = schemas[name as ToolName].safeParse(rawInput ?? {});
  if (!parsed.success) {
    const error = `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`;
    await logTool(ctx.sessionId, name, rawInput, false, error);
    return { ok: false, error };
  }
  try {
    const data = await run(name as ToolName, parsed.data, ctx.sessionId);
    await logTool(ctx.sessionId, name, parsed.data, true, "ok");
    return { ok: true, data };
  } catch (e) {
    const error = e instanceof PayPalError ? e.toUserMessage() : e instanceof Error ? e.message : "Unexpected error";
    await logTool(ctx.sessionId, name, parsed.data, false, error);
    return { ok: false, error };
  }
};

export { getLatestOrder as latestOrder };
