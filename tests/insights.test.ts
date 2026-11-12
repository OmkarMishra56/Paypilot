import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ orders: [] as any[], events: [] as any[], hooks: [] as any[] }));
vi.mock("@/lib/db", () => ({ prisma: {
  order: { findFirst: async ({ where }: any) => {
    const { sessionId, ...rest } = where;
    const rows = h.orders.filter((o) => o.sessionId === sessionId && Object.entries(rest).every(([k, v]) => o[k] === v));
    return rows[rows.length - 1] ?? null;
  } },
  event: { findMany: async ({ where }: any) => h.events.filter((e) => e.orderId === where.orderId) },
  webhookLog: { findMany: async ({ where }: any) => h.hooks.filter((x) => where.eventId.in.includes(x.eventId)) },
} }));

import { explainOrder } from "@/lib/insights";
import { maskId, resultLabel, sourceLabel, timeLabel } from "@/lib/activity";

const t = (s: string) => new Date(s);
beforeEach(() => {
  h.orders = [{ id: "o1", sessionId: "s1", paypalOrderId: "PP1", status: "PARTIALLY_REFUNDED", currency: "USD", totalCents: 8700,
    itemsJson: JSON.stringify([{ name: "Bottle", qty: 3, unitCents: 2900 }]), captureId: "CAP1", capturedCents: 8700, refundedCents: 500, invoiceId: null, invoiceStatus: null }];
  h.events = [
    { orderId: "o1", type: "ORDER_CREATED", source: "tool", payloadJson: JSON.stringify({ status: "CREATED" }), createdAt: t("2026-11-12T10:00:00Z") },
    { orderId: "o1", type: "PAYMENT_CAPTURED", source: "user_confirmed", payloadJson: JSON.stringify({ capturedCents: 8700, expectedCents: 8700 }), createdAt: t("2026-11-12T10:01:00Z") },
    { orderId: "o1", type: "REFUND_RECORDED", source: "user_confirmed", payloadJson: JSON.stringify({ refundId: "R1", cents: 500, reason: "item damaged" }), createdAt: t("2026-11-12T10:02:00Z") },
    { orderId: "o1", type: "PAYMENT.CAPTURE.REFUNDED", source: "webhook", payloadJson: JSON.stringify({ eventId: "WE1", summary: "refund R1 $5.00" }), createdAt: t("2026-11-12T10:03:00Z") },
  ];
  h.hooks = [{ eventId: "WE1", eventType: "PAYMENT.CAPTURE.REFUNDED", verified: true, createdAt: t("2026-11-12T10:03:01Z") }];
});

describe("explainOrder", () => {
  it("returns recorded facts: amounts, refund reason, webhook verification", async () => {
    const r: any = await explainOrder("s1");
    expect(r.order).toMatchObject({ status: "PARTIALLY_REFUNDED", total: "$87.00", refunded: "$5.00", still_refundable: "$82.00" });
    expect(r.refunds).toEqual([expect.objectContaining({ amount: "$5.00", reason: "item damaged" })]);
    expect(r.webhooks_received).toEqual([expect.objectContaining({ event: "PAYMENT.CAPTURE.REFUNDED", signature_verified: true })]);
    expect(r.timeline.map((x: any) => x.what)).toContain("PayPal webhook: refund completed");
  });
  it("says the reason is not recorded instead of inventing one", async () => {
    h.events[2].payloadJson = JSON.stringify({ refundId: "R1", cents: 500 });
    const r: any = await explainOrder("s1");
    expect(r.refunds[0].reason).toBeNull();
    expect(r.timeline.find((x: any) => x.what === "Refund recorded").detail).toContain("no reason recorded");
  });
  it("finds orders by capture id and never crosses sessions", async () => {
    expect(await explainOrder("s1", "CAP1")).not.toBeNull();
    expect(await explainOrder("other", "CAP1")).toBeNull();
    expect(await explainOrder("s1", "nope")).toBeNull();
  });
  it("redacts emails inside timeline details", async () => {
    h.events.push({ orderId: "o1", type: "INVOICE_SENT", source: "user_confirmed", payloadJson: JSON.stringify({ invoiceNumber: "0001", to: "bob@example.com", totalCents: 100 }), createdAt: t("2026-11-12T10:04:00Z") });
    const r: any = await explainOrder("s1");
    expect(JSON.stringify(r)).not.toContain("bob@");
  });
});

describe("activity helpers", () => {
  it("shortens ids and labels rows", () => {
    expect(maskId("A-VERY-LONG-PAYPAL-ID")).toBe("A-VERY-L…");
    expect(maskId("short")).toBe("short");
    expect(resultLabel({ ok: true, httpStatus: 201 })).toBe("201");
    expect(resultLabel({ ok: false })).toBe("failed");
    expect(sourceLabel("paypal")).toBe("PayPal API");
    expect(timeLabel("2026-11-12T10:03:04Z")).toBe("10:03:04Z");
  });
});
