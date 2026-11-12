import { describe, it, expect, beforeEach, vi } from "vitest";
import { __setDeps, createOrder, captureOrder, refundCapture, createInvoiceDraft, sendInvoice, verifyWebhookSignature, PayPalError, redact } from "@/lib/paypal";

process.env.PAYPAL_CLIENT_ID = "cid"; process.env.PAYPAL_CLIENT_SECRET = "sec"; process.env.PAYPAL_WEBHOOK_ID = "WH1";
const ok = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>; let logs: any[];
beforeEach(() => {
  logs = []; fetchMock = vi.fn();
  __setDeps({ fetch: fetchMock as any, log: (e) => { logs.push(e); } });
});
const token = () => ok({ access_token: "tok", expires_in: 3600 });

describe("paypal wrapper", () => {
  it("caches the OAuth token across calls", async () => {
    fetchMock.mockResolvedValueOnce(token())
      .mockResolvedValueOnce(ok({ id: "O1", status: "CREATED", links: [] }))
      .mockResolvedValueOnce(ok({ id: "O2", status: "CREATED", links: [] }));
    const items = [{ name: "Mug", unitCents: 1250, qty: 2 }];
    await createOrder(items); await createOrder(items);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/oauth2/token"))).toHaveLength(1);
  });

  it("creates an order with correct totals, idempotency key and approve link", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(
      ok({ id: "O1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://pp/approve" }] }));
    const r = await createOrder([{ name: "Mug", unitCents: 1250, qty: 2 }, { name: "Pen", unitCents: 399, qty: 1 }], "USD", "req-1");
    const [url, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(init.body);
    expect(String(url)).toContain("/v2/checkout/orders");
    expect(init.headers["PayPal-Request-Id"]).toBe("req-1");
    expect(body.purchase_units[0].amount.value).toBe("28.99");
    expect(body.purchase_units[0].items[0].unit_amount.value).toBe("12.50");
    expect(r).toEqual({ id: "O1", status: "PAYER_ACTION_REQUIRED", approveUrl: "https://pp/approve" });
  });

  it("surfaces PayPal debug_id on errors and logs the failure", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(
      ok({ name: "UNPROCESSABLE_ENTITY", debug_id: "abc123", details: [{ issue: "ORDER_NOT_APPROVED", description: "Buyer has not approved" }] }, 422));
    await expect(captureOrder("O1")).rejects.toMatchObject({ debugId: "abc123", issue: "ORDER_NOT_APPROVED", status: 422 });
    expect(logs.at(-1)).toMatchObject({ ok: false, debugId: "abc123" });
  });

  it("parses capture id and amount", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(
      ok({ id: "O1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", amount: { value: "28.99", currency_code: "USD" } }] } }] }));
    expect(await captureOrder("O1")).toMatchObject({ captureId: "CAP1", capturedCents: 2899, status: "COMPLETED" });
  });

  it("refund sends amount + idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(ok({ id: "R1", status: "COMPLETED" }));
    await refundCapture("CAP1", 500, "USD", "damaged", "rf-1");
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain("/v2/payments/captures/CAP1/refund");
    expect(JSON.parse(init.body).amount).toEqual({ value: "5.00", currency_code: "USD" });
    expect(init.headers["PayPal-Request-Id"]).toBe("rf-1");
  });

  it("verifies webhook signatures", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(ok({ verification_status: "SUCCESS" }));
    expect(await verifyWebhookSignature({ "paypal-transmission-id": "t" }, { id: "E1" })).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).webhook_id).toBe("WH1");
  });

  it("sends the raw webhook body to PayPal byte-for-byte", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(ok({ verification_status: "SUCCESS" }));
    const raw = '{ "id" : "E1", "n": 1.10 }';
    await verifyWebhookSignature({}, raw);
    expect(fetchMock.mock.calls[1][1].body).toContain(`"webhook_event":${raw}}`);
  });

  it("creates an invoice draft (numbered first) and sends it with separate idempotency keys", async () => {
    fetchMock.mockResolvedValueOnce(token())
      .mockResolvedValueOnce(ok({ invoice_number: "0007" }))
      .mockResolvedValueOnce(ok({ href: "https://api/v2/invoicing/invoices/INV2-7" }, 201))
      .mockResolvedValueOnce(ok({}, 202));
    const d = await createInvoiceDraft("team@example.com", [{ name: "Mug", unitCents: 1800, qty: 2 }], "Thanks", "USD", "inv-1");
    expect(d).toEqual({ invoiceId: "INV2-7", invoiceNumber: "0007" });
    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body.detail.invoice_number).toBe("0007");
    expect(body.primary_recipients[0].billing_info.email_address).toBe("team@example.com");
    expect(body.items[0]).toMatchObject({ quantity: "2", unit_amount: { value: "18.00" } });
    expect(fetchMock.mock.calls[2][1].headers["PayPal-Request-Id"]).toBe("inv-1");
    await sendInvoice("INV2-7", "Thanks", "inv-1-send");
    expect(String(fetchMock.mock.calls[3][0])).toContain("/v2/invoicing/invoices/INV2-7/send");
    expect(fetchMock.mock.calls[3][1].headers["PayPal-Request-Id"]).toBe("inv-1-send");
  });

  it("redacts emails and tokens", () => {
    expect(redact("to bob@example.com Bearer abc.def")).toBe("to ***@example.com Bearer [redacted]");
  });
  it("PayPalError gives a user-facing message", () => {
    expect(new PayPalError("nope", 400, "d1", "X").toUserMessage()).toContain("d1");
  });
});
