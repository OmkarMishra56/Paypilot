/**
 * Server-side ONLY. Every PayPal call in the app goes through this file.
 * - OAuth token cached in memory until shortly before expiry
 * - PayPal-Request-Id (idempotency key) on every write
 * - Errors carry PayPal's debug_id; every call is logged (redacted)
 */
import { randomUUID } from "crypto";
import { fromCents } from "./money";

export type Currency = "USD";
export interface LineItem { name: string; sku?: string; unitCents: number; qty: number }

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public debugId?: string,
    public issue?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
  /** Plain-language text safe to hand to the agent. */
  toUserMessage() {
    return `PayPal declined the request (${this.issue ?? this.status}${this.debugId ? `, debug_id ${this.debugId}` : ""}): ${this.message}`;
  }
}

export interface CallLog {
  method: string; path: string; httpStatus: number; ok: boolean;
  requestId?: string; debugId?: string; paypalId?: string; summary: string;
}

type Deps = { fetch: typeof fetch; log: (e: CallLog) => void | Promise<void>; now: () => number };

async function defaultLog(e: CallLog) {
  console.log("[paypal]", JSON.stringify(e));
  try {
    const { prisma } = await import("./db");
    await prisma.toolLog.create({
      data: { kind: "paypal", name: `${e.method} ${e.path}`, method: e.method, path: e.path,
        httpStatus: e.httpStatus, ok: e.ok, requestId: e.requestId, debugId: e.debugId,
        paypalId: e.paypalId, summary: e.summary },
    });
  } catch { /* DB logging is best-effort */ }
}

let deps: Deps = { fetch: (...a) => fetch(...a), log: defaultLog, now: () => Date.now() };
let tokenCache: { token: string; expiresAt: number } | null = null;

/** Test hook. */
export function __setDeps(d: Partial<Deps>) { deps = { ...deps, ...d }; tokenCache = null; }

function cfg() {
  const base = process.env.PAYPAL_BASE || "https://api-m.sandbox.paypal.com";
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
  return { base, id, secret };
}

/** Redact emails + long opaque tokens before anything is shown in the activity log. */
export function redact(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "***@$1")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

export async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - 60_000 > deps.now()) return tokenCache.token;
  const { base, id, secret } = cfg();
  const res = await deps.fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    await deps.log({ method: "POST", path: "/v1/oauth2/token", httpStatus: res.status, ok: false,
      summary: redact(String(json.error_description ?? json.error ?? "token request failed")) });
    throw new PayPalError(json.error_description ?? "Could not authenticate with PayPal", res.status, undefined, json.error);
  }
  tokenCache = { token: json.access_token, expiresAt: deps.now() + (json.expires_in ?? 300) * 1000 };
  return tokenCache.token;
}

interface CallOpts { body?: unknown; requestId?: string; write?: boolean; extractId?: (j: any) => string | undefined; summary?: (j: any) => string }

async function call<T = any>(method: "GET" | "POST", path: string, o: CallOpts = {}): Promise<T> {
  const { base } = cfg();
  const token = await getAccessToken();
  const requestId = o.write ? o.requestId ?? randomUUID() : undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const res = await deps.fetch(`${base}${path}`, { method, headers, body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body) });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  const debugId = json.debug_id ?? res.headers?.get?.("paypal-debug-id") ?? undefined;
  if (!res.ok) {
    const issue = json.details?.[0]?.issue ?? json.name;
    const msg = json.details?.[0]?.description ?? json.message ?? `HTTP ${res.status}`;
    await deps.log({ method, path, httpStatus: res.status, ok: false, requestId, debugId, summary: redact(`${issue ?? "ERROR"}: ${msg}`) });
    throw new PayPalError(msg, res.status, debugId, issue, json.details);
  }
  await deps.log({ method, path, httpStatus: res.status, ok: true, requestId, debugId,
    paypalId: o.extractId?.(json) ?? json.id, summary: redact(o.summary?.(json) ?? "ok") });
  return json as T;
}

// ---------- Orders v2 ----------
export interface CreatedOrder { id: string; status: string; approveUrl?: string }

export async function createOrder(items: LineItem[], currency: Currency = "USD", requestId?: string): Promise<CreatedOrder> {
  if (!items.length) throw new Error("Cannot create an order from an empty cart");
  const totalCents = items.reduce((s, i) => s + i.unitCents * i.qty, 0);
  const total = fromCents(totalCents);
  const body = {
    intent: "CAPTURE",
    purchase_units: [{
      amount: { currency_code: currency, value: total, breakdown: { item_total: { currency_code: currency, value: total } } },
      items: items.map((i) => ({
        name: i.name.slice(0, 127), sku: i.sku, quantity: String(i.qty),
        unit_amount: { currency_code: currency, value: fromCents(i.unitCents) }, category: "PHYSICAL_GOODS",
      })),
    }],
    application_context: { user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" },
  };
  const j = await call("POST", "/v2/checkout/orders", { body, write: true, requestId, summary: (r) => `order ${r.status} ${total} ${currency}` });
  return { id: j.id, status: j.status, approveUrl: j.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href };
}

export interface CaptureResult { orderId: string; status: string; captureId?: string; capturedCents: number; currency: string }

export async function captureOrder(orderId: string, requestId?: string): Promise<CaptureResult> {
  const j = await call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    body: {}, write: true, requestId, extractId: (r) => r.purchase_units?.[0]?.payments?.captures?.[0]?.id,
    summary: (r) => `capture ${r.status}`,
  });
  const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
  return { orderId: j.id, status: j.status, captureId: cap?.id, capturedCents: cap ? Math.round(Number(cap.amount.value) * 100) : 0, currency: cap?.amount?.currency_code ?? "USD" };
}

export const getOrder = (orderId: string) => call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { summary: (r) => `order ${r.status}` });

// ---------- Payments v2 (refund) ----------
export async function refundCapture(captureId: string, amountCents: number, currency: Currency, reason: string, requestId?: string) {
  const j = await call("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    body: { amount: { value: fromCents(amountCents), currency_code: currency }, note_to_payer: reason.slice(0, 255) },
    write: true, requestId, summary: (r) => `refund ${r.status} ${fromCents(amountCents)}`,
  });
  return { refundId: j.id as string, status: j.status as string };
}

// ---------- Invoicing v2 ----------
export async function createInvoiceDraft(
  recipientEmail: string, items: LineItem[], note: string, currency: Currency = "USD", requestId?: string,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const num = await call("POST", "/v2/invoicing/generate-next-invoice-number", { write: true, summary: () => "next invoice number" });
  const draft = await call("POST", "/v2/invoicing/invoices", {
    write: true, requestId,
    body: {
      detail: { invoice_number: num.invoice_number, currency_code: currency, ...(note ? { note: note.slice(0, 4000) } : {}) },
      primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
      items: items.map((i) => ({ name: i.name.slice(0, 200), quantity: String(i.qty), unit_amount: { currency_code: currency, value: fromCents(i.unitCents) } })),
    },
    extractId: (r) => String(r.href ?? "").split("/").pop(), summary: () => "invoice draft created",
  });
  const invoiceId = String(draft.href ?? "").split("/").pop() as string;
  if (!invoiceId) throw new PayPalError("PayPal did not return an invoice id", 502);
  return { invoiceId, invoiceNumber: num.invoice_number as string };
}

export async function sendInvoice(invoiceId: string, note: string, requestId?: string): Promise<void> {
  await call("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
    write: true, requestId, extractId: () => invoiceId,
    body: { send_to_recipient: true, send_to_invoicer: false, ...(note ? { note } : {}) }, summary: () => "invoice sent",
  });
}

export async function createAndSendInvoice(recipientEmail: string, items: LineItem[], note: string, currency: Currency = "USD", requestId?: string) {
  const d = await createInvoiceDraft(recipientEmail, items, note, currency, requestId);
  await sendInvoice(d.invoiceId, note, requestId ? `${requestId}-send` : undefined);
  return d;
}

// ---------- Webhooks ----------
/** `event` may be the RAW request body string. PayPal verifies a CRC of the exact bytes, so we splice it in unparsed. */
export async function verifyWebhookSignature(headers: Headers | Record<string, string | null | undefined>, event: unknown): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not set");
  const h = (k: string) => (headers instanceof Headers ? headers.get(k) : headers[k]) ?? "";
  const raw = typeof event === "string" ? event : JSON.stringify(event);
  JSON.parse(raw); // must be valid JSON
  const head = JSON.stringify({
    auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"), webhook_id: webhookId,
  });
  const body = `${head.slice(0, -1)},"webhook_event":${raw}}`;
  const j = await call("POST", "/v1/notifications/verify-webhook-signature", { write: false, body, summary: (r) => `verify ${r.verification_status}` });
  return j.verification_status === "SUCCESS";
}
