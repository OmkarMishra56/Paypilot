import { z } from "zod";
import { cancelConfirmation, confirmAction, ConfirmationError, getPendingConfirmation } from "@/lib/confirm";
import { PayPalError } from "@/lib/paypal";
import { SESSION_ID_RE } from "@/lib/types";

export const dynamic = "force-dynamic";
const Body = z.object({ sessionId: z.string().regex(SESSION_ID_RE), token: z.string().min(8).max(64), decision: z.enum(["approve", "cancel"]) });

export async function GET(req: Request) {
  const s = new URL(req.url).searchParams.get("session") ?? "";
  if (!SESSION_ID_RE.test(s)) return Response.json({ error: "Invalid session" }, { status: 400 });
  return Response.json({ confirmation: await getPendingConfirmation(s) });
}

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { sessionId, token, decision } = p.data;
  if (decision === "cancel") { await cancelConfirmation(sessionId, token); return Response.json({ confirmation: null }); }
  try {
    const r = await confirmAction(sessionId, token);
    return Response.json({ order: r.order, message: r.message, confirmation: await getPendingConfirmation(sessionId) });
  } catch (e) {
    if (e instanceof ConfirmationError) return Response.json({ error: e.message }, { status: 409 });
    if (e instanceof PayPalError) return Response.json({ error: e.toUserMessage(), retryable: e.status >= 500 || e.status === 429 }, { status: 502 });
    console.error("[confirm]", e);
    return Response.json({ error: "Unexpected error. Please try again." }, { status: 500 });
  }
}
