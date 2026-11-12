import { describe, it, expect } from "vitest";
import { toOpenAIMessages } from "@/lib/llm";

describe("OpenAI message adapter", () => {
  it("converts tool_use and tool_result blocks", () => {
    const out = toOpenAIMessages("sys", [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "view_cart", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"x\":1}" }] },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[2].tool_calls[0]).toMatchObject({ id: "t1", function: { name: "view_cart", arguments: "{}" } });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "{\"x\":1}" });
  });
  it("echoes Gemini thought_signature back on tool calls", () => {
    const sig = { google: { thought_signature: "abc" } };
    const out = toOpenAIMessages("s", [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search_products", input: {}, extra_content: sig }] }]);
    expect(out[1].tool_calls[0].extra_content).toEqual(sig);
  });
});
