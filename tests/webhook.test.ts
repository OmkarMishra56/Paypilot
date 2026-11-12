import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ orders: new Map<string, any>(), events: [] as any[], logs: new Map<string, any>() }));
vi.mock("@/lib/db", () => {
  const eq = (row: any, where: any) => Object.entries(where).every(([k, v]: any) =>
    v && typeof v === "object" && "contains" in v ? String(row[k]).includes(v.contains) : row[k] === v);
  return { prisma: {
    order: {
      findFirst: async ({ where }: any) => [...h.orders.values()].find((o) => eq(o, where)) ?? null,
      update: async ({ where, data }: any) => Object.assign(h.orders.get(where.id), data),
    },
    event: { create: async ({ data }: any) => { h.events.push(data); return data; }, findFirst: async ({ where }: any) => h.events.find((e) => eq(e, where)) ?? null },
    webhookLog: { findUnique: async ({ where }: any) => h.logs.get(where.eventId) ?? null, create: async ({ data }: any) => { h.logs.set(data.eventId, data); return data; } },
    toolLog: { create: vi.fn() },
  } };
});
vi.mock("@/lib/paypal", async (orig) => ({ ...(await orig<typeof import("@/lib/paypal")>()), verifyWebhookSignature: vi.fn() }));

import { processWebhookEvent } from "@/lib/webhook";
import { subscribe } from "@/lib/sse";
import { verifyWebhookSignature, PayPalError } from "@/lib/paypal";
import { POST } from "@/app/api/paypal/webhook/route";

process.env.PAYPAL_WEBHOOK_ID = "WH1";
const verify = vi.mocked(verifyWebhookSignature);
const base = () => ({ id: "o1", sessionId: "sess-1", paypalOrderId: "PP1", status: "APPROVED", currency: "USD", totalCents: 8700,
  itemsJson: "[]", captureId: null, capturedCents: 0, refundedCents: 0, invoiceId: null, invoiceStatus: null });
const completed = (id = "WE1") => ({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP1", amount: { value: "87.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: "PP1" } } } });
const refunded = (refundId: string, value: string) => ({ id: `WE-${refundId}`, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: refundId, amount: { value, currency_code: "USD" }, links: [{ rel: "up", href: "https://api/v2/payments/captures/CAP1" }] } });

let pushed: any[];
let unsub: () => void;
afterEach(() => unsub());
beforeEach(() => {
  h.orders.clear(); h.events.length = 0; h.logs.clear(); verify.mockReset(); pushed = [];
  h.orders.set("o1", base());
  unsub = subscribe("sess-1", (e) => pushed.push(e));
});

describe("webhook processing", () => {
  it("capture.completed marks the order paid and pushes a chat status", async () => {
    const r = await processWebhookEvent(completed());
    expect(r).toMatchObject({ handled: true, orderId: "o1" });
    expect(h.orders.get("o1")).toMatchObject({ status: "CAPTURED", captureId: "CAP1", capturedCents: 8700 });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].text).toContain("$87.00");
  });
  it("counts each refund id once and moves partial -> full", async () => {
    h.orders.set("o1", { ...base(), status: "CAPTURED", captureId: "CAP1", capturedCents: 8700 });
    await processWebhookEvent(refunded("R1", "20.00"));
    await processWebhookEvent(refunded("R1", "20.00")); // duplicate delivery
    expect(h.orders.get("o1")).toMatchObject({ refundedCents: 2000, status: "PARTIALLY_REFUNDED" });
    await processWebhookEvent(refunded("R2", "67.00"));
    expect(h.orders.get("o1")).toMatchObject({ refundedCents: 8700, status: "REFUNDED" });
  });
  it("a late capture event never downgrades a refunded order", async () => {
    h.orders.set("o1", { ...base(), status: "REFUNDED", captureId: "CAP1", capturedCents: 8700, refundedCents: 8700 });
    await processWebhookEvent(completed());
    expect(h.orders.get("o1").status).toBe("REFUNDED");
  });
  it("unknown orders are logged, not thrown", async () => {
    const ev = completed(); ev.resource.supplementary_data.related_ids.order_id = "NOPE"; ev.resource.id = "CAPX";
    expect(await processWebhookEvent(ev)).toEqual({ handled: false });
  });
  it("invoice.paid updates the invoice status", async () => {
    h.orders.set("o1", { ...base(), invoiceId: "INV2-1" });
    await processWebhookEvent({ id: "WE9", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-1", detail: { invoice_number: "0001" } } } });
    expect(h.orders.get("o1").invoiceStatus).toBe("PAID");
    expect(pushed[0].text).toContain("0001");
  });
  it("invoice.paid moves an invoiced order to INVOICE_PAID", async () => {
    h.orders.set("o1", { ...base(), status: "INVOICED", invoiceId: "INV2-1", invoiceStatus: "SENT" });
    await processWebhookEvent({ id: "WE10", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-1" } } });
    expect(h.orders.get("o1")).toMatchObject({ status: "INVOICE_PAID", invoiceStatus: "PAID" });
  });
});

describe("webhook route", () => {
  const req = (body: unknown) => new Request("http://x/api/paypal/webhook", { method: "POST", body: JSON.stringify(body), headers: { "paypal-transmission-id": "t" } });
  it("rejects bad signatures without touching any order", async () => {
    verify.mockResolvedValue(false);
    const res = await POST(req(completed()));
    expect(res.status).toBe(400);
    expect(h.orders.get("o1").status).toBe("APPROVED");
    expect([...h.logs.values()][0]).toMatchObject({ verified: false });
    expect(pushed).toHaveLength(0);
  });
  it("processes a verified event once and ignores the duplicate", async () => {
    verify.mockResolvedValue(true);
    expect((await POST(req(completed()))).status).toBe(200);
    const again = await (await POST(req(completed()))).json();
    expect(again.duplicate).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(h.orders.get("o1").status).toBe("CAPTURED");
  });
  it("treats a PayPal 400 on the verify call (bad/missing headers) as unverified, not a server error", async () => {
    verify.mockRejectedValue(new PayPalError("bad request", 400, "dbg", "INVALID_REQUEST"));
    expect((await POST(req(completed()))).status).toBe(400);
    expect(h.orders.get("o1").status).toBe("APPROVED");
  });
  it("asks PayPal to retry (5xx) when verification itself fails", async () => {
    verify.mockRejectedValue(new Error("network"));
    expect((await POST(req(completed()))).status).toBe(500);
  });
});
