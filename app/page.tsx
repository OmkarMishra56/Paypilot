"use client";
import { useCallback, useEffect, useState } from "react";
import Chat from "@/components/Chat";
import CartPanel from "@/components/CartPanel";
import ConfirmModal from "@/components/ConfirmModal";
import { SESSION_ID_RE, type CartView, type ConfirmationView, type OrderView } from "@/lib/types";

export default function Home() {
  const [sessionId, setSessionId] = useState("");
  const [cart, setCart] = useState<CartView | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationView | null>(null);
  const [notice, setNotice] = useState("");
  const [ask, setAsk] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get("session");
    let id = fromUrl || localStorage.getItem("paypilot-session") || "";
    if (!SESSION_ID_RE.test(id)) id = crypto.randomUUID();
    localStorage.setItem("paypilot-session", id);
    setSessionId(id);
  }, []);

  const apply = useCallback((j: { cart: CartView; order: OrderView | null }) => { setCart(j.cart); setOrder(j.order); }, []);
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/cart?session=${sessionId}`).then((r) => r.json()).then(apply).catch(() => {});
    fetch(`/api/confirm?session=${sessionId}`).then((r) => r.json()).then((j) => setConfirmation(j.confirmation ?? null)).catch(() => {});
  }, [sessionId, apply]);

  const act = (method: string, path: string) => () => fetch(`${path}?session=${sessionId}`, { method }).then((r) => r.json()).then(apply);

  /** Buyer approved in PayPal -> server verifies with PayPal and opens a confirmation. No money moves here. */
  async function onApprove(paypalOrderId: string) {
    setNotice("");
    const r = await fetch("/api/orders/approved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, paypalOrderId }) });
    const j = await r.json();
    if (!r.ok) { setNotice(j.error ?? "Could not verify the approval with PayPal."); return; }
    setOrder(j.order); setConfirmation(j.confirmation ?? null);
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-rule bg-white px-5 py-3">
        <div className="flex items-baseline gap-4"><span className="text-lg font-semibold">PayPilot</span><a href="/activity" target="_blank" rel="noreferrer" className="text-sm text-pay underline underline-offset-2">Activity log</a></div>
        <span className="rounded bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">PayPal sandbox. No real money.</span>
      </header>
      {notice && <div role="alert" className="border-b border-rule bg-warn/10 px-5 py-2 text-sm text-warn">{notice}</div>}
      <main className="grid min-h-0 flex-1 lg:grid-cols-[1fr_380px]">
        <Chat sessionId={sessionId} onCart={setCart} onOrder={setOrder} onConfirmation={setConfirmation} ask={ask} />
        <CartPanel cart={cart} order={order} confirmation={confirmation} onClear={act("DELETE", "/api/cart")} onDemo={act("POST", "/api/demo")} onApprove={onApprove} onAsk={(text) => setAsk({ id: Date.now(), text })} />
      </main>
      {confirmation && (
        <ConfirmModal key={confirmation.token} confirmation={confirmation} sessionId={sessionId}
          onClose={() => setConfirmation(null)} onDone={(o) => { if (o) setOrder(o); setConfirmation(null); }} />
      )}
    </div>
  );
}
