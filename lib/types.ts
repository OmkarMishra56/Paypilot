/** Client-safe shared types (no server imports here). */
export type CartLineView = { productId: string; name: string; unitCents: number; qty: number; lineCents: number };
export type CartView = { items: CartLineView[]; totalCents: number; currency: "USD" };
export type OrderView = {
  id: string; paypalOrderId: string | null; status: string; currency: string; totalCents: number;
  items: { name: string; qty: number; unitCents: number }[];
  captureId: string | null; capturedCents: number; refundedCents: number;
  invoiceId: string | null; invoiceStatus: string | null;
};
/** Wire protocol of /api/chat (NDJSON, one JSON object per line). */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; phase: "start" | "end"; ok?: boolean }
  | { type: "cart"; cart: CartView }
  | { type: "order"; order: OrderView | null }
  | { type: "confirmation"; confirmation: ConfirmationView | null }
  | { type: "error"; message: string }
  | { type: "done" };
export const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export type ConfirmationView = {
  token: string; action: "capture" | "invoice" | "refund"; title: string;
  amountCents: number; currency: string;
  items: { name: string; qty: number; unitCents: number }[];
  detail?: string; expiresAt: string;
};

/** Server-sent events pushed to the chat (from PayPal webhooks). */
export type PushEvent = { type: "status"; text: string; order: OrderView | null };
