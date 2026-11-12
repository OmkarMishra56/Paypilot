import { toolDefs, type ToolCtx, type ToolExecutor, type ToolResult } from "./tools";

export const MODEL = "claude-sonnet-4-6";
export const MAX_ITERATIONS = 8;

export const SYSTEM_PROMPT = `You are PayPilot, a shopping assistant that completes purchases through PayPal (sandbox/test mode, USD).
- Use tools for everything factual. Never invent products, ids, prices or order status.
- Find products with search_products (respect any budget as max_price), add chosen items with add_to_cart, and show the cart with view_cart.
- Only call create_paypal_order when the shopper clearly wants to check out. Summarize the cart and total first if they haven't seen it. After it succeeds, tell them to approve with the PayPal buttons in the side panel.
- Money only moves when the shopper presses Confirm in a dialog shown in the UI. capture_paypal_order, create_invoice and refund_order only OPEN that dialog; afterwards ask the shopper to review and confirm it. Never claim a payment, invoice or refund happened unless a status line in the chat or get_order_status says so.
- After the shopper approves in PayPal, call capture_paypal_order. To "bill my team" or invoice someone, ask for the recipient's email if you don't have it (never invent one), then call create_invoice (it bills the current cart by default).
- For "explain this order" or "why was it refunded" questions, call explain_order and answer ONLY from the facts it returns, in plain language. If something (such as a refund reason) is not recorded, say it is not recorded. Never guess.
- For refunds, find the capture_id with get_order_status, then call refund_order. A refund can never exceed what was captured.
- If a tool returns an error, explain it in plain language (include a PayPal debug_id if given) and offer to retry or suggest an alternative.
- Keep replies short and friendly. Prices are in USD.`;

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown; result: ToolResult }
  | { type: "done"; iterations: number }
  | { type: "error"; message: string };

export interface HistoryMessage { role: "user" | "assistant"; content: string }

/** Minimal surface of the Anthropic SDK we use (so tests can inject a fake). */
export interface LLMClient { messages: { stream: (params: any) => { on: (ev: "text", cb: (d: string) => void) => unknown; finalMessage: () => Promise<any> } } }

export async function runAgent(opts: {
  client: LLMClient; exec: ToolExecutor; sessionId: string; history: HistoryMessage[];
  onEvent: (e: AgentEvent) => void; maxIterations?: number; tools?: unknown[];
}) {
  const { client, exec, sessionId, onEvent } = opts;
  const max = opts.maxIterations ?? MAX_ITERATIONS;
  const ctx: ToolCtx = { sessionId };
  const messages: any[] = opts.history.map((m) => ({ role: m.role, content: m.content }));

  for (let i = 1; i <= max; i++) {
    const stream = client.messages.stream({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools: opts.tools ?? toolDefs, messages });
    stream.on("text", (delta) => onEvent({ type: "text", delta }));
    const final = await stream.finalMessage();
    messages.push({ role: "assistant", content: final.content });
    if (final.stop_reason !== "tool_use") { onEvent({ type: "done", iterations: i }); return; }

    const results: any[] = [];
    for (const block of final.content) {
      if (block.type !== "tool_use") continue;
      const result = await exec(block.name, block.input, ctx);
      onEvent({ type: "tool", id: block.id, name: block.name, input: block.input, result });
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result.ok ? result.data : { error: result.error }), is_error: !result.ok });
    }
    messages.push({ role: "user", content: results });
  }
  onEvent({ type: "text", delta: "\n\nI've reached my step limit for this request. Tell me what to do next and I'll continue." });
  onEvent({ type: "done", iterations: max });
}
