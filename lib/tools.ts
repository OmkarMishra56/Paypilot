import { z } from "zod";

/** Strict input schemas for every agent tool. Validated server-side before anything runs. */
export const schemas = {
  search_products: z.object({
    query: z.string().min(1).max(200).describe("What the shopper is looking for, e.g. 'coffee mug' or 'gift for a runner'"),
    max_price: z.number().positive().max(100000).optional().describe("Maximum unit price in USD"),
  }).strict(),
  add_to_cart: z.object({
    product_id: z.string().min(1).describe("Product id from search_products, e.g. 'p01'"),
    qty: z.number().int().min(1).max(20).default(1),
  }).strict(),
  view_cart: z.object({}).strict(),
  create_paypal_order: z.object({}).strict(),
  capture_paypal_order: z.object({
    order_id: z.string().min(1).describe("PayPal order id of an order the buyer has already approved"),
  }).strict(),
  create_invoice: z.object({
    recipient_email: z.string().email().max(254).describe("Email of the person/team to bill. Ask the shopper if they haven't said; never invent one."),
    items: z.array(z.object({ product_id: z.string().min(1), qty: z.number().int().min(1).max(20).default(1) }).strict()).min(1).max(20).optional()
      .describe("Catalog products to bill. Defaults to the current cart."),
    note: z.string().max(500).optional().describe("Optional note shown on the invoice"),
  }).strict(),
  refund_order: z.object({
    capture_id: z.string().min(1).describe("PayPal capture id of a paid order (see get_order_status)"),
    amount: z.number().positive().max(100000).optional().describe("USD amount to refund. Defaults to everything still refundable."),
    reason: z.string().min(1).max(255).describe("Why the refund is being made"),
  }).strict(),
  explain_order: z.object({
    order_id: z.string().min(1).optional().describe("Order id, PayPal order id, capture id or invoice id. Defaults to the latest order in this session."),
  }).strict(),
  get_order_status: z.object({
    order_id: z.string().min(1).describe("PayPal order id or internal order id"),
  }).strict(),
} as const;

export type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  search_products: "Search the product catalog by keyword, optionally with a max unit price in USD. Returns up to 8 products.",
  add_to_cart: "Add a catalog product to the shopper's cart.",
  view_cart: "Show the current cart with line totals and the grand total.",
  create_paypal_order: "Create a PayPal order from the current cart so the shopper can approve it with the PayPal buttons shown in the side panel. Does NOT move money.",
  capture_paypal_order: "Ask the shopper to confirm payment for an order they approved in PayPal. This only OPENS a confirmation dialog in the UI; it never charges anything by itself.",
  create_invoice: "Prepare a PayPal invoice for a recipient email (defaults to the current cart). This only OPENS a confirmation dialog in the UI; nothing is sent until the shopper confirms.",
  refund_order: "Prepare a refund for a paid order. This only OPENS a confirmation dialog in the UI; nothing is refunded until the shopper confirms. The amount can never exceed what is still refundable.",
  explain_order: "Get the recorded timeline for an order (events, webhook log, refunds with reasons). Use it for \"explain this order\" and \"why was it refunded\" questions.",
  get_order_status: "Look up an order's current status and recent events (created, approved, captured, refunded, invoice paid).",
};

export const toolDefs = (Object.keys(schemas) as ToolName[]).map((name) => {
  const { $schema, ...input_schema } = z.toJSONSchema(schemas[name]) as Record<string, unknown>;
  return { name, description: descriptions[name], input_schema: input_schema as { type: "object"; [k: string]: unknown } };
});

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };
export interface ToolCtx { sessionId: string }
export type ToolExecutor = (name: string, input: unknown, ctx: ToolCtx) => Promise<ToolResult>;
