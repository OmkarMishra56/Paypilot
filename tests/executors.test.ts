import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: { toolLog: { create: vi.fn() }, cart: { findUnique: vi.fn(async () => null), upsert: vi.fn() }, order: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() }, event: { create: vi.fn() } } }));
import { executeTool } from "@/lib/executors";

const ctx = { sessionId: "test-session-1" };
describe("tool executor", () => {
  it("rejects invalid input before running anything", async () => {
    const r = await executeTool("add_to_cart", { product_id: "p01", qty: 0 }, ctx);
    expect(r.ok).toBe(false);
  });
  it("rejects unknown tools and unknown products", async () => {
    expect((await executeTool("drop_tables", {}, ctx)).ok).toBe(false);
    const r = await executeTool("add_to_cart", { product_id: "nope", qty: 1 }, ctx);
    expect(r).toMatchObject({ ok: false });
  });
  it("refuses to create a PayPal order from an empty cart", async () => {
    const r = await executeTool("create_paypal_order", {}, ctx);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/empty/i) });
  });
  it("search_products returns catalog items within budget", async () => {
    const r = await executeTool("search_products", { query: "gift", max_price: 20 }, ctx);
    expect(r.ok).toBe(true);
    expect((r as any).data.products.every((p: any) => p.priceCents <= 2000)).toBe(true);
  });
});
