"use client";
import { useEffect, useRef, useState } from "react";
import type { CartView, ConfirmationView, OrderView, PushEvent, StreamEvent } from "@/lib/types";

type Msg = { id: string; role: "user" | "assistant"; content: string; kind?: "status"; tools?: { id: string; name: string; ok: boolean }[] };
const IDEAS = ["Find me a gift under $50 and bill my team", "What desk accessories do you have under $20?", "Show my cart and check out"];
const uid = () => crypto.randomUUID();

export default function Chat({ sessionId, onCart, onOrder, onConfirmation, ask }: {
  ask?: { id: number; text: string } | null; sessionId: string; onCart: (c: CartView) => void; onOrder: (o: OrderView | null) => void; onConfirmation: (c: ConfirmationView | null) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs]);

  // Live PayPal webhook updates (SSE) land in the chat as status lines and refresh the order panel.
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/events?session=${sessionId}`);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as PushEvent;
        if (e.type !== "status") return;
        setMsgs((p) => [...p, { id: uid(), role: "assistant", content: e.text, kind: "status" }]);
        if (e.order) onOrder(e.order);
      } catch { /* ignore malformed */ }
    };
    return () => es.close();
  }, [sessionId, onOrder]);

  const patch = (id: string, fn: (m: Msg) => Msg) => setMsgs((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

  function handle(e: StreamEvent, aid: string) {
    if (e.type === "text") patch(aid, (m) => ({ ...m, content: m.content + e.delta }));
    else if (e.type === "tool") patch(aid, (m) => ({ ...m, tools: [...(m.tools ?? []), { id: e.id, name: e.name, ok: !!e.ok }] }));
    else if (e.type === "cart") onCart(e.cart);
    else if (e.type === "order") onOrder(e.order);
    else if (e.type === "confirmation") onConfirmation(e.confirmation);
    else if (e.type === "error") patch(aid, (m) => ({ ...m, content: m.content ? `${m.content}\n\n${e.message}` : e.message }));
  }

  async function send(text: string) {
    if (!text.trim() || busy || !sessionId) return;
    const aid = uid();
    const history: Msg[] = [...msgs, { id: uid(), role: "user", content: text.trim() }];
    setMsgs([...history, { id: aid, role: "assistant", content: "", tools: [] }]);
    setInput(""); setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, messages: history.filter((m) => m.content).map(({ role, content }) => ({ role, content })) }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(JSON.parse(line), aid); }
      }
    } catch (e) {
      patch(aid, (m) => ({ ...m, content: m.content || `Something went wrong: ${(e as Error).message}` }));
    } finally { setBusy(false); }
  }

  // Buttons in the order panel ("Explain this order") ask the agent through the normal chat flow.
  const lastAsk = useRef(0);
  useEffect(() => { if (ask && ask.id !== lastAsk.current) { lastAsk.current = ask.id; send(ask.text); } }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="flex min-h-0 flex-col" aria-label="Chat">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        {msgs.length === 0 ? (
          <div className="mx-auto max-w-xl pt-10">
            <h1 className="text-2xl font-semibold">What are we buying today?</h1>
            <p className="mt-2 text-mist">Tell me what you need. I search the catalog, build the cart and set up the PayPal checkout. Nothing is charged until you approve it.</p>
            <div className="mt-6 flex flex-col items-start gap-2">
              {IDEAS.map((t) => (<button key={t} onClick={() => send(t)} className="rounded-full border border-rule bg-white px-4 py-2 text-left text-sm hover:border-pay">{t}</button>))}
            </div>
          </div>
        ) : (
          <ul className="mx-auto flex max-w-2xl flex-col gap-4">
            {msgs.map((m, i) => m.kind === "status" ? (
              <li key={m.id} className="self-start rounded-md bg-good/10 px-3 py-2 text-sm font-medium text-good">{m.content}</li>
            ) : (
              <li key={m.id} className={m.role === "user" ? "self-end rounded-2xl bg-ink px-4 py-2 text-white" : "self-start"}>
                {m.tools && m.tools.length > 0 && (
                  <div className="mb-1 flex flex-wrap gap-1">
                    {m.tools.map((t) => (<span key={t.id} className={`rounded px-2 py-0.5 text-xs ${t.ok ? "bg-white text-mist ring-1 ring-rule" : "bg-warn/10 text-warn"}`}>{t.name}{t.ok ? "" : " failed"}</span>))}
                  </div>
                )}
                <p className="whitespace-pre-wrap leading-relaxed">{m.content || (busy && i === msgs.length - 1 ? "Thinking…" : "")}</p>
              </li>
            ))}
          </ul>
        )}
        <div ref={end} />
      </div>
      <div className="border-t border-rule bg-white p-4">
        <div className="mx-auto flex max-w-2xl gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(input)}
            placeholder="Ask for a product, edit the cart, or check out" aria-label="Message" disabled={busy}
            className="min-w-0 flex-1 rounded-lg border border-rule px-3 py-2 disabled:bg-paper" />
          <button onClick={() => send(input)} disabled={busy || !input.trim()} className="rounded-lg bg-pay px-4 py-2 font-medium text-white disabled:opacity-40">Send</button>
        </div>
      </div>
    </section>
  );
}
