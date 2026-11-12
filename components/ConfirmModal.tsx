"use client";
import { useEffect, useRef, useState } from "react";
import type { ConfirmationView, OrderView } from "@/lib/types";

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const COPY = {
  capture: { note: "Nothing is charged until you press the button below.", cta: (a: string) => `Confirm and pay ${a}` },
  invoice: { note: "Nothing is sent until you press the button below.", cta: (a: string) => `Send invoice for ${a}` },
  refund: { note: "Nothing is refunded until you press the button below.", cta: (a: string) => `Refund ${a}` },
} as const;

export default function ConfirmModal({ confirmation, sessionId, onDone, onClose }: {
  confirmation: ConfirmationView; sessionId: string; onDone: (order: OrderView | null) => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirmBtn.current?.focus(); }, []);

  async function decide(decision: "approve" | "cancel") {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, token: confirmation.token, decision }) });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? "Something went wrong."); return; }
      if (decision === "cancel") { onClose(); return; }
      onDone(j.order ?? null);
    } catch { setError("Network error. Please try again."); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4" onKeyDown={(e) => e.key === "Escape" && !busy && decide("cancel")}>
      <div role="dialog" aria-modal="true" aria-labelledby="cm-title" className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 id="cm-title" className="text-lg font-semibold">{confirmation.title}</h2>
        <p className="mt-1 text-sm text-mist">{COPY[confirmation.action].note}</p>
        <p className="mt-4 text-3xl font-semibold tabular-nums">{usd(confirmation.amountCents)} <span className="text-base font-normal text-mist">{confirmation.currency}</span></p>
        <ul className="mt-4 divide-y divide-rule border-y border-rule text-sm">
          {confirmation.items.map((i) => (
            <li key={i.name} className="flex justify-between gap-3 py-2"><span>{i.name} <span className="text-mist">× {i.qty}</span></span><span className="tabular-nums">{usd(i.unitCents * i.qty)}</span></li>
          ))}
        </ul>
        {confirmation.detail && <p className="mt-3 text-sm text-mist">{confirmation.detail}</p>}
        {error && <p role="alert" className="mt-3 rounded bg-warn/10 px-3 py-2 text-sm text-warn">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => decide("cancel")} disabled={busy} className="rounded-lg border border-rule px-4 py-2 text-sm font-medium disabled:opacity-40">Not now</button>
          <button ref={confirmBtn} onClick={() => decide("approve")} disabled={busy} className="rounded-lg bg-pay px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            {busy ? "Working…" : error ? "Try again" : COPY[confirmation.action].cta(usd(confirmation.amountCents))}
          </button>
        </div>
      </div>
    </div>
  );
}
