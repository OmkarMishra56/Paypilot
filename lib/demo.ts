import { addToCart, clearCart } from "./cart";

/** Sample cart for judges: a gift under $50 plus a team snack box. */
export async function seedDemoCart(sessionId: string) {
  await clearCart(sessionId);
  await addToCart(sessionId, "p01", 2);
  await addToCart(sessionId, "p11", 1);
}
