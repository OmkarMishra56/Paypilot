import { describe, it, expect } from "vitest";
import { searchProducts, getProduct } from "@/lib/catalog";
import { schemas, toolDefs } from "@/lib/tools";

describe("catalog", () => {
  it("finds products by keyword", () => {
    expect(searchProducts("coffee mug")[0].name).toBe("Ceramic Coffee Mug");
  });
  it("respects max_price", () => {
    const r = searchProducts("desk", 20);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => Number(p.price) <= 20)).toBe(true);
  });
  it("returns nothing for nonsense and has 20 products", () => {
    expect(searchProducts("zzzzqx")).toEqual([]);
    expect(getProduct("p20")?.priceCents).toBe(8900);
  });
  it("a bare gift query returns gift items under budget", () => {
    const r = searchProducts("a gift under $50", 50);
    expect(r.length).toBeGreaterThan(0);
  });
});

describe("tool schemas", () => {
  it("defaults qty and rejects bad input", () => {
    expect(schemas.add_to_cart.parse({ product_id: "p01" }).qty).toBe(1);
    expect(schemas.add_to_cart.safeParse({ product_id: "p01", qty: 0 }).success).toBe(false);
    expect(schemas.add_to_cart.safeParse({ product_id: "p01", qty: 1, extra: 1 }).success).toBe(false);
  });
  it("exports JSON schemas for every tool without $schema", () => {
    expect(toolDefs.map((t) => t.name)).toContain("create_paypal_order");
    for (const t of toolDefs) { expect(t.input_schema.type).toBe("object"); expect((t.input_schema as any).$schema).toBeUndefined(); }
  });
});
