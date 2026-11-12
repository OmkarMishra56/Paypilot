import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

const h = vi.hoisted(() => ({ conf: new Map<string, any>(), orders: new Map<string, any>(), events: [] as any[], n: 0 }));
vi.mock("@/lib/db", () => {
  const eq = (row: any, where: any) => Object.entries(where).every(([k, v]: any) =>
    k === "expiresAt" ? row.expiresAt > v.gt
      : v && typeof v === "object" && "contains" in v ? String(row[k]).includes(v.contains) : row[k] === v);
  return { prisma: {
    confirmation: {
      create: async ({ data }: any) => { const r = { status: "pending", createdAt: new Date(), ...data }; h.conf.set(r.id, r); return r; },
      findUnique: async ({ where }: any) => h.conf.get(where.id) ?? null,
      findFirst: async ({ where }: any) => [...h.conf.values()].find((r) => eq(r, where)) ?? null,
      updateMany: async ({ where, data }: any) => { const r = [...h.conf.values()].filter((x) => eq(x, where)); r.forEach((x) => Object.assign(x, data)); return { count: r.length }; },
      update: async ({ where, data }: any) => Object.assign(h.conf.get(where.id), data),
    },
    order: {
      findFirst: async ({ where }: any) => [...h.orders.values()].find((o) => eq(o, where)) ?? null,
      create: async ({ data }: any) => { const o = { id: `ord${++h.n}`, paypalOrderId: null, captureId: null, capturedCents: 0, refundedCents: 0, invoiceId: null, invoiceStatus: null, ...data }; h.orders.set(o.id, o); return o; },
      update: async ({ where, data }: any) => Object.assign(h.orders.get(where.id), data),
    },
    event: { create: async ({ data }: any) => { h.events.push(data); return data; }, findFirst: async ({ where }: any) => h.events.find((e) => eq(e, where)) ?? null },
    toolLog: { create: vi.fn() },
  } };
});
vi.mock("@/lib/paypal", async (orig) => ({
  ...(await orig<typeof import("@/lib/paypal")>()),
  captureOrder: vi.fn(), refundCapture: vi.fn(), createInvoiceDraft: vi.fn(), sendInvoice: vi.fn(),
}));

import { proposeCapture, proposeInvoice, proposeRefund, confirmAction, ConfirmationError, cancelConfirmation } from "@/lib/confirm";
import { recordRefund } from "@/lib/orders";
import { captureOrder, refundCapture, createInvoiceDraft, sendInvoice, PayPalError } from "@/lib/paypal";

const cap = vi.mocked(captureOrder), refund = vi.mocked(refundCapture), draft = vi.mocked(createInvoiceDraft), send = vi.mocked(sendInvoice);
const ok = { orderId: "PP1", status: "COMPLETED", captureId: "CAP1", capturedCents: 8700, currency: "USD" };
const seed = (over: any = {}) => h.orders.set("o1", { id: "o1", sessionId: "s1", paypalOrderId: "PP1", status: "APPROVED", currency: "USD", totalCents: 8700,
  itemsJson: JSON.stringify([{ productId: "p01", name: "Bottle", unitCents: 2900, qty: 3 }]), captureId: null, capturedCents: 0, refundedCents: 0, invoiceId: null, invoiceStatus: null, ...over });
const seedPaid = (over: any = {}) => seed({ status: "CAPTURED", captureId: "CAP1", capturedCents: 8700, ...over });

beforeEach(() => {
  h.conf.clear(); h.orders.clear(); h.events.length = 0; h.n = 0;
  [cap, refund, draft, send].forEach((m) => m.mockReset());
  seed();
});

describe("capture guardrail", () => {
  it("proposing never calls PayPal and shows the server-side amount", async () => {
    const c = await proposeCapture("s1", "o1");
    expect(cap).not.toHaveBeenCalled();
    expect(c).toMatchObject({ action: "capture", amountCents: 8700, currency: "USD" });
  });
  it("refuses to propose capture for an order the buyer has not approved", async () => {
    h.orders.get("o1").status = "CREATED";
    await expect(proposeCapture("s1", "o1")).rejects.toBeInstanceOf(ConfirmationError);
  });
  it("rejects unknown tokens without calling PayPal", async () => {
    await expect(confirmAction("s1", "made-up-token")).rejects.toBeInstanceOf(ConfirmationError);
    expect(cap).not.toHaveBeenCalled();
  });
  it("captures exactly once per token, with an idempotency key tied to the token", async () => {
    cap.mockResolvedValue(ok);
    const { token } = await proposeCapture("s1", "o1");
    const r = await confirmAction("s1", token);
    expect(r.order.status).toBe("CAPTURED");
    expect(cap).toHaveBeenCalledWith("PP1", `cap-${token}`);
    await expect(confirmAction("s1", token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(cap).toHaveBeenCalledTimes(1);
  });
  it("rejects a token from another session", async () => {
    const { token } = await proposeCapture("s1", "o1");
    await expect(confirmAction("other-session", token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(cap).not.toHaveBeenCalled();
  });
  it("rejects expired and cancelled tokens", async () => {
    const a = await proposeCapture("s1", "o1");
    h.conf.get(a.token).expiresAt = new Date(Date.now() - 1000);
    await expect(confirmAction("s1", a.token)).rejects.toBeInstanceOf(ConfirmationError);
    const b = await proposeCapture("s1", "o1");
    await cancelConfirmation("s1", b.token);
    await expect(confirmAction("s1", b.token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(cap).not.toHaveBeenCalled();
  });
  it("re-opens the token when PayPal fails, so a retry reuses the same request id", async () => {
    cap.mockRejectedValueOnce(new PayPalError("temporary", 503, "dbg1")).mockResolvedValueOnce(ok);
    const { token } = await proposeCapture("s1", "o1");
    await expect(confirmAction("s1", token)).rejects.toBeInstanceOf(PayPalError);
    expect(h.orders.get("o1").status).toBe("APPROVED");
    await confirmAction("s1", token);
    expect(cap.mock.calls.map((c) => c[1])).toEqual([`cap-${token}`, `cap-${token}`]);
    expect(h.orders.get("o1").status).toBe("CAPTURED");
  });
  it("does not mark paid if PayPal's capture is not COMPLETED", async () => {
    cap.mockResolvedValue({ ...ok, status: "PENDING" });
    const { token } = await proposeCapture("s1", "o1");
    await expect(confirmAction("s1", token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(h.orders.get("o1").status).toBe("APPROVED");
  });
});

describe("refund guardrail", () => {
  beforeEach(() => { h.orders.clear(); seedPaid(); refund.mockResolvedValue({ refundId: "RF1", status: "COMPLETED" }); });

  it("caps the refund at what was captured, at proposal time", async () => {
    await expect(proposeRefund("s1", { captureId: "CAP1", amountCents: 8701, reason: "x" })).rejects.toThrow(/most that can still be refunded/);
    expect(refund).not.toHaveBeenCalled();
  });
  it("defaults to the full refundable remainder", async () => {
    h.orders.get("o1").refundedCents = 2000;
    expect((await proposeRefund("s1", { captureId: "CAP1", reason: "damaged" })).amountCents).toBe(6700);
  });
  it("re-checks the cap at execution if the remainder shrank after the dialog opened", async () => {
    const { token } = await proposeRefund("s1", { captureId: "CAP1", amountCents: 5000, reason: "damaged" });
    h.orders.get("o1").refundedCents = 5000; // another refund landed meanwhile
    await expect(confirmAction("s1", token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(refund).not.toHaveBeenCalled();
  });
  it("refunds exactly once with a token-derived idempotency key and updates the order", async () => {
    const { token } = await proposeRefund("s1", { captureId: "CAP1", amountCents: 2000, reason: "damaged" });
    expect(refund).not.toHaveBeenCalled();
    const r = await confirmAction("s1", token);
    expect(refund).toHaveBeenCalledWith("CAP1", 2000, "USD", "damaged", `rf-${token}`);
    expect(r.order).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedCents: 2000 });
    await expect(confirmAction("s1", token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(refund).toHaveBeenCalledTimes(1);
  });
  it("is not double counted when PayPal's webhook reports the same refund", async () => {
    const { token } = await proposeRefund("s1", { captureId: "CAP1", amountCents: 2000, reason: "damaged" });
    await confirmAction("s1", token);
    expect(await recordRefund("o1", "RF1", 2000, "webhook")).toBe(false);
    expect(h.orders.get("o1").refundedCents).toBe(2000);
  });
  it("marks the order REFUNDED when the full amount goes back", async () => {
    const { token } = await proposeRefund("s1", { captureId: "CAP1", reason: "cancelled" });
    expect((await confirmAction("s1", token)).order.status).toBe("REFUNDED");
  });
  it("refuses orders that were never captured, and unknown capture ids", async () => {
    h.orders.get("o1").status = "APPROVED";
    await expect(proposeRefund("s1", { captureId: "CAP1", reason: "x" })).rejects.toBeInstanceOf(ConfirmationError);
    await expect(proposeRefund("s1", { captureId: "NOPE", reason: "x" })).rejects.toBeInstanceOf(ConfirmationError);
  });
  it("does not record a refund PayPal reports as FAILED", async () => {
    refund.mockResolvedValue({ refundId: "RF9", status: "FAILED" });
    const { token } = await proposeRefund("s1", { captureId: "CAP1", amountCents: 1000, reason: "x" });
    await expect(confirmAction("s1", token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(h.orders.get("o1").refundedCents).toBe(0);
  });
});

describe("invoice guardrail", () => {
  const lines = [{ productId: "p01", qty: 2 }, { productId: "p11", qty: 1 }];
  beforeEach(() => { draft.mockResolvedValue({ invoiceId: "INV2-1", invoiceNumber: "0001" }); send.mockResolvedValue(undefined); });

  it("proposing never calls PayPal; totals come from the catalog, not the caller", async () => {
    const c = await proposeInvoice("s1", { recipientEmail: "team@example.com", lines });
    expect(draft).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(c).toMatchObject({ action: "invoice", amountCents: 2400 * 2 + 3900 });
    expect(c.detail).toContain("team@example.com");
  });
  it("rejects invalid emails and unknown products", async () => {
    await expect(proposeInvoice("s1", { recipientEmail: "not-an-email", lines })).rejects.toBeInstanceOf(ConfirmationError);
    await expect(proposeInvoice("s1", { recipientEmail: "a@b.co", lines: [{ productId: "zzz", qty: 1 }] })).rejects.toBeInstanceOf(ConfirmationError);
  });
  it("creates the draft and sends it only after confirmation, with token-derived keys", async () => {
    const { token } = await proposeInvoice("s1", { recipientEmail: "team@example.com", note: "Team gifts", lines });
    const r = await confirmAction("s1", token);
    expect(draft).toHaveBeenCalledWith("team@example.com", expect.any(Array), "Team gifts", "USD", `inv-${token}`);
    expect(send).toHaveBeenCalledWith("INV2-1", "Team gifts", `inv-${token}-send`);
    expect(r.order).toMatchObject({ status: "INVOICED", invoiceId: "INV2-1", invoiceStatus: "SENT", totalCents: 8700 });
    expect(r.message).toContain("t***@example.com");
    await expect(confirmAction("s1", token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("after a send failure, a retry reuses the draft instead of creating a second invoice", async () => {
    send.mockRejectedValueOnce(new PayPalError("temporary", 503, "dbg2")).mockResolvedValueOnce(undefined);
    const { token } = await proposeInvoice("s1", { recipientEmail: "team@example.com", lines });
    await expect(confirmAction("s1", token)).rejects.toBeInstanceOf(PayPalError);
    await confirmAction("s1", token);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect([...h.orders.values()].filter((o) => o.invoiceId === "INV2-1")).toHaveLength(1);
  });
});

describe("structural guarantee", () => {
  it("only lib/confirm.ts and lib/paypal.ts reference money-moving PayPal functions", () => {
    const banned = /\b(captureOrder|refundCapture|createAndSendInvoice|createInvoiceDraft|sendInvoice)\b/;
    const allowed = new Set(["lib/paypal.ts", "lib/confirm.ts"]);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []);
    const offenders = ["lib", "app", "components"].flatMap(walk)
      .map((f) => f.split(path.sep).join("/")).filter((f) => !allowed.has(f) && banned.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
