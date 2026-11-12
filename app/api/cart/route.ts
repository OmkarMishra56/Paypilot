import { cartView, clearCart } from "@/lib/cart";
import { getLatestOrder } from "@/lib/orders";
import { SESSION_ID_RE } from "@/lib/types";

export const dynamic = "force-dynamic";
const sid = (req: Request) => { const s = new URL(req.url).searchParams.get("session") ?? ""; return SESSION_ID_RE.test(s) ? s : null; };

export async function GET(req: Request) {
  const s = sid(req); if (!s) return Response.json({ error: "Invalid session" }, { status: 400 });
  return Response.json({ cart: await cartView(s), order: await getLatestOrder(s) });
}
export async function DELETE(req: Request) {
  const s = sid(req); if (!s) return Response.json({ error: "Invalid session" }, { status: 400 });
  await clearCart(s);
  return Response.json({ cart: await cartView(s), order: await getLatestOrder(s) });
}
