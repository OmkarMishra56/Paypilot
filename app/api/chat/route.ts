import { z } from "zod";
import { runAgent } from "@/lib/agent";
import { createLLMClient, llmConfigError } from "@/lib/llm";
import { executeTool } from "@/lib/executors";
import { cartView } from "@/lib/cart";
import { getLatestOrder } from "@/lib/orders";
import { getPendingConfirmation } from "@/lib/confirm";
import { SESSION_ID_RE, type StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  sessionId: z.string().regex(SESSION_ID_RE),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) })).min(1).max(40),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const cfgErr = llmConfigError();
  if (cfgErr) return Response.json({ error: cfgErr }, { status: 500 });
  const { sessionId } = parsed.data;
  const history = [...parsed.data.messages];
  while (history.length && history[0].role !== "user") history.shift(); // API requires the first turn to be the user's

  const client = createLLMClient();
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: StreamEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      let chain: Promise<void> = Promise.resolve();
      const queue = (fn: () => Promise<void>) => { chain = chain.then(fn).catch(() => {}); };
      try {
        await runAgent({
          client, exec: executeTool, sessionId, history,
          onEvent: (e) => {
            if (e.type === "text") emit({ type: "text", delta: e.delta });
            else if (e.type === "tool") queue(async () => {
              emit({ type: "tool", id: e.id, name: e.name, phase: "end", ok: e.result.ok });
              emit({ type: "cart", cart: await cartView(sessionId) });
              emit({ type: "order", order: await getLatestOrder(sessionId) });
              emit({ type: "confirmation", confirmation: await getPendingConfirmation(sessionId) });
            });
            else if (e.type === "error") emit({ type: "error", message: e.message });
          },
        });
      } catch (err: any) {
        const msg = err?.status === 401 ? "The AI provider rejected the API key." : err?.status === 429 ? "Rate limited by the AI provider. Please retry in a moment." : "The assistant hit an error. Please try again.";
        console.error("[chat]", err?.message ?? err);
        emit({ type: "error", message: msg });
      }
      await chain;
      emit({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });
}
