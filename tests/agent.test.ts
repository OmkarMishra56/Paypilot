import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentEvent } from "@/lib/agent";

function fakeClient(turns: any[]) {
  let i = 0; const calls: any[] = [];
  return {
    calls,
    client: { messages: { stream: (params: any) => {
      calls.push(JSON.parse(JSON.stringify(params.messages)));
      const turn = turns[Math.min(i++, turns.length - 1)]; let cb: (d: string) => void = () => {};
      return { on: (_e: "text", f: (d: string) => void) => { cb = f; }, finalMessage: async () => { for (const b of turn.content) if (b.type === "text") cb(b.text); return turn; } };
    } } },
  };
}
const toolTurn = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "search_products", input: { query: "mug" } }] };
const endTurn = { stop_reason: "end_turn", content: [{ type: "text", text: "Found a mug!" }] };

describe("agent loop", () => {
  it("runs tool then answers, feeding tool_result back", async () => {
    const { client, calls } = fakeClient([toolTurn, endTurn]);
    const exec = vi.fn(async () => ({ ok: true as const, data: { count: 1 } }));
    const events: AgentEvent[] = [];
    await runAgent({ client, exec, sessionId: "s1", history: [{ role: "user", content: "mug?" }], onEvent: (e) => events.push(e) });
    expect(exec).toHaveBeenCalledWith("search_products", { query: "mug" }, { sessionId: "s1" });
    const second = calls[1]; const last = second[second.length - 1];
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: false });
    expect(events.map((e) => e.type)).toEqual(["tool", "text", "done"]);
  });
  it("marks failed tools as errors so the model can explain them", async () => {
    const { client, calls } = fakeClient([toolTurn, endTurn]);
    await runAgent({ client, exec: async () => ({ ok: false, error: "PayPal declined (debug_id x)" }), sessionId: "s", history: [], onEvent: () => {} });
    const last = calls[1][calls[1].length - 1];
    expect(last.content[0].is_error).toBe(true);
    expect(last.content[0].content).toContain("debug_id x");
  });
  it("stops after 8 iterations", async () => {
    const { client } = fakeClient([toolTurn]);
    const exec = vi.fn(async () => ({ ok: true as const, data: {} }));
    const events: AgentEvent[] = [];
    await runAgent({ client, exec, sessionId: "s", history: [], onEvent: (e) => events.push(e) });
    expect(exec).toHaveBeenCalledTimes(8);
    expect(events.at(-1)).toEqual({ type: "done", iterations: 8 });
  });
});
