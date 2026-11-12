import { prisma } from "./db";
import { getProduct } from "./catalog";
import type { CartView } from "./types";

export class CartError extends Error {}
type Line = { productId: string; qty: number };
const MAX_QTY = 20;

async function load(sessionId: string): Promise<Line[]> {
  const c = await prisma.cart.findUnique({ where: { sessionId } });
  return c ? (JSON.parse(c.itemsJson) as Line[]) : [];
}
async function save(sessionId: string, lines: Line[]) {
  const itemsJson = JSON.stringify(lines);
  await prisma.cart.upsert({ where: { sessionId }, create: { sessionId, itemsJson }, update: { itemsJson } });
}

export async function addToCart(sessionId: string, productId: string, qty: number): Promise<CartView> {
  if (!getProduct(productId)) throw new CartError(`Unknown product_id "${productId}". Use search_products to find valid ids.`);
  const lines = await load(sessionId);
  const line = lines.find((l) => l.productId === productId);
  const next = (line?.qty ?? 0) + qty;
  if (next > MAX_QTY) throw new CartError(`Max ${MAX_QTY} units per product.`);
  if (line) line.qty = next; else lines.push({ productId, qty });
  await save(sessionId, lines);
  return cartView(sessionId);
}

export async function clearCart(sessionId: string) { await save(sessionId, []); }

/** Prices ALWAYS come from the server-side catalog, never from the model. */
export async function cartView(sessionId: string): Promise<CartView> {
  const items = (await load(sessionId)).flatMap((l) => {
    const p = getProduct(l.productId);
    return p ? [{ productId: p.id, name: p.name, unitCents: p.priceCents, qty: l.qty, lineCents: p.priceCents * l.qty }] : [];
  });
  return { items, totalCents: items.reduce((s, l) => s + l.lineCents, 0), currency: "USD" };
}

export const cartToLineItems = (v: CartView) =>
  v.items.map((l) => ({ name: l.name, sku: l.productId, unitCents: l.unitCents, qty: l.qty }));
