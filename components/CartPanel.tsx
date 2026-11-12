"use client";
import type { CartView, ConfirmationView, OrderView } from "@/lib/types";
import PayPalCheckout from "./PayPalCheckout";

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const STATUS: Record<string, { label: string; tone: string }> = {
  CREATED: { label: "Waiting for your PayPal approval", tone: "text-warn" },
  APPROVED: { label: "Approved in PayPal. Waiting for your confirmation.", tone: "text-pay" },
  CAPTURED: { label: "Paid", tone: "text-good" },
  PARTIALLY_REFUNDED: { label: "Partially refunded", tone: "text-warn" },
  REFUNDED: { label: "Refunded", tone: "text-mist" },
  FAILED: { label: "Payment failed", tone: "text-warn" },
  INVOICE_DRAFT: { label: "Invoice drafted, not sent", tone: "text-warn" },
  INVOICED: { label: "Invoice sent. Waiting for payment.", tone: "text-pay" },
  INVOICE_PAID: { label: "Invoice paid", tone: "text-good" },
};

export default function CartPanel(p: {
  cart: CartView | null; order: OrderView | null; confirmation: ConfirmationView | null;
  onClear: () => void; onDemo: () => void; onApprove: (paypalOrderId: string) => Promise<void>; onAsk: (text: string) => void;
}) {
  const items = p.cart?.items ?? [];
  const st = p.order ? STATUS[p.order.status] ?? { label: p.order.status, tone: "text-mist" } : null;
  return (
    <aside className="flex flex-col gap-6 overflow-y-auto border-l border-rule bg-white p-5">
      <section aria-label="Cart">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Cart</h2>
          {items.length > 0 && <button onClick={p.onClear} className="text-sm text-mist underline underline-offset-2 hover:text-ink">Clear</button>}
        </div>
        {items.length === 0 ? (
          <div className="mt-3 text-sm text-mist">
            <p>Nothing here yet. Ask the assistant for ideas, or</p>
            <button onClick={p.onDemo} className="mt-2 rounded-md border border-rule px-3 py-1.5 font-medium text-ink hover:bg-paper">Load the demo cart</button>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-rule text-sm">
            {items.map((l) => (
              <li key={l.productId} className="flex justify-between gap-3 py-2">
                <span>{l.name}<span className="text-mist"> × {l.qty}</span></span>
                <span className="tabular-nums">{usd(l.lineCents)}</span>
              </li>
            ))}
            <li className="flex justify-between py-2 font-semibold"><span>Total</span><span className="tabular-nums">{usd(p.cart!.totalCents)}</span></li>
          </ul>
        )}
      </section>

      {p.order && st && (
        <section aria-label="Order" className="rounded-lg border border-rule p-4">
          <h2 className="text-base font-semibold">Order {usd(p.order.totalCents)}</h2>
          <p className={`mt-1 text-sm font-medium ${st.tone}`}>{st.label}</p>
          <p className="mt-1 break-all text-xs text-mist">{p.order.paypalOrderId ? `PayPal order ${p.order.paypalOrderId}` : p.order.invoiceId ? `Invoice ${p.order.invoiceId}` : ""}</p>
          {p.order.refundedCents > 0 && <p className="mt-1 text-xs text-mist">Refunded {usd(p.order.refundedCents)} of {usd(p.order.capturedCents || p.order.totalCents)}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => p.onAsk("Explain this order")} className="rounded-md border border-rule px-2.5 py-1 text-xs font-medium hover:bg-paper">Explain this order</button>
            {p.order.refundedCents > 0 && <button onClick={() => p.onAsk("Why was it refunded?")} className="rounded-md border border-rule px-2.5 py-1 text-xs font-medium hover:bg-paper">Why was it refunded?</button>}
          </div>
          {p.order.status === "CAPTURED" && p.order.captureId && <p className="mt-1 break-all text-xs text-mist">Capture {p.order.captureId}</p>}
          {p.order.status === "APPROVED" && !p.confirmation && (
            <button onClick={() => p.onApprove(p.order!.paypalOrderId!)} className="mt-3 rounded-lg bg-pay px-4 py-2 text-sm font-medium text-white">Review and confirm payment</button>
          )}
          {p.order.status === "CREATED" && (
            <div className="mt-4"><PayPalCheckout order={p.order} onApprove={p.onApprove} /></div>
          )}
        </section>
      )}
    </aside>
  );
}
