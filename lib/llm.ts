/**
 * LLM provider switch. agent.ts talks to an Anthropic-shaped client; this file supplies either
 * the real Anthropic SDK or an adapter over any OpenAI-compatible API (OpenAI, Gemini, Groq, ...).
 *   LLM_PROVIDER=openai|anthropic   (default: openai if OPENAI_API_KEY is set, else anthropic)
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { LLMClient } from "./agent";

export function llmProvider(): "openai" | "anthropic" {
  const p = process.env.LLM_PROVIDER?.toLowerCase();
  if (p === "openai" || p === "anthropic") return p;
  return process.env.OPENAI_API_KEY ? "openai" : "anthropic";
}

/** Returns a human-readable problem if the selected provider is not configured. */
export function llmConfigError(): string | null {
  return llmProvider() === "openai"
    ? process.env.OPENAI_API_KEY ? null : "OPENAI_API_KEY is not set on the server."
    : process.env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY is not set on the server.";
}

/** Anthropic-style messages (what agent.ts builds) -> OpenAI chat messages. */
export function toOpenAIMessages(system: string, messages: any[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const calls = m.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        // Gemini requires its thought_signature to be echoed back with the tool call
        ...(b.extra_content ? { extra_content: b.extra_content } : {}),
      }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content) });
    }
  }
  return out;
}

function openAIClient(): LLMClient {
  const oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
  return {
    messages: {
      stream: (params: any) => {
        let onText: (d: string) => void = () => {};
        return {
          on: (_ev: "text", cb: (d: string) => void) => { onText = cb; },
          finalMessage: async () => {
            const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
            const stream = await oa.chat.completions.create({
              model, stream: true,
              messages: toOpenAIMessages(params.system, params.messages),
              tools: (params.tools ?? []).map((t: any) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
            });
            let text = ""; const calls: Record<number, { id: string; name: string; args: string; extra?: unknown }> = {};
            for await (const chunk of stream) {
              const d = chunk.choices[0]?.delta; if (!d) continue;
              if (d.content) { text += d.content; onText(d.content); }
              for (const tc of d.tool_calls ?? []) {
                const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
                if (tc.id) c.id = tc.id; if (tc.function?.name) c.name += tc.function.name; if (tc.function?.arguments) c.args += tc.function.arguments;
                if ((tc as any).extra_content) c.extra = (tc as any).extra_content;
              }
            }
            const toolBlocks = Object.values(calls).map((c, i) => {
              let input: unknown = {}; try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { __invalid_json: c.args.slice(0, 200) }; }
              return { type: "tool_use", id: c.id || `call_${Date.now()}_${i}`, name: c.name, input, ...(c.extra ? { extra_content: c.extra } : {}) };
            });
            return { content: [...(text ? [{ type: "text", text }] : []), ...toolBlocks], stop_reason: toolBlocks.length ? "tool_use" : "end_turn" };
          },
        };
      },
    },
  };
}

export function createLLMClient(): LLMClient {
  return llmProvider() === "openai" ? openAIClient() : (new Anthropic() as unknown as LLMClient);
}
