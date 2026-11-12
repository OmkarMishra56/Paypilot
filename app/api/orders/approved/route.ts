import { z } from "zod";
import { prisma } from "@/lib/db";
import { toOrderView } from "@/lib/orders";
import { getOrder, PayPalError } from "@/lib/paypal";
import { proposeCapture } from "@/lib/confirm";
import { SESSION_ID_RE } from "@/lib/types";

export const dynamic = "force-dynamic";
const Body = z.object({ sessionId: z.string().regex(SESSION_ID_RE), paypalOrderId: z.string().min(1).max(64) });

/**
 * Called after the buyer approves in the PayPal popup (or clicks "Review and confirm").
 * Verifies approval with PayPal server-side, then OPENS a confirmation. Moves NO money.
 */
export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { sessionId, paypalOrderId } = p.data;
  let o = await prisma.order.findFirst({ where: { sessionId, paypalOrderId } });
  if (!o) return Response.json({ error: "Order not found" }, { status: 404 });
  if (o.status === "CREATED") {
    try {
      const pp = await getOrder(paypalOrderId);
      if (pp.status !== "APPROVED") return Response.json({ error: `PayPal reports this order as ${pp.status}, not approved yet.` }, { status: 409 });
    } catch (e) {
      if (e instanceof PayPalError) return Response.json({ error: e.toUserMessage() }, { status: 502 });
      throw e;
    }
    o = await prisma.order.update({ where: { id: o.id }, data: { status: "APPROVED" } });
    await prisma.event.create({ data: { orderId: o.id, type: "ORDER_APPROVED", source: "user", payloadJson: JSON.stringify({ paypalOrderId }) } });
  }
  const confirmation = o.status === "APPROVED" ? await proposeCapture(sessionId, o.id) : null;
  return Response.json({ order: toOrderView(o), confirmation });
}
