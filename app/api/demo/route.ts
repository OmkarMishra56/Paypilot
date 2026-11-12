import { seedDemoCart } from "@/lib/demo";
import { cartView } from "@/lib/cart";
import { getLatestOrder } from "@/lib/orders";
import { SESSION_ID_RE } from "@/lib/types";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const s = new URL(req.url).searchParams.get("session") ?? "";
  if (!SESSION_ID_RE.test(s)) return Response.json({ error: "Invalid session" }, { status: 400 });
  await seedDemoCart(s);
  return Response.json({ cart: await cartView(s), order: await getLatestOrder(s) });
}
