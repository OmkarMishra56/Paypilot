import { subscribe } from "@/lib/sse";
import { SESSION_ID_RE } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const s = new URL(req.url).searchParams.get("session") ?? "";
  if (!SESSION_ID_RE.test(s)) return Response.json({ error: "Invalid session" }, { status: 400 });
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(": connected\n\n"));
      const unsub = subscribe(s, (e) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)));
      const hb = setInterval(() => { try { controller.enqueue(enc.encode(": hb\n\n")); } catch { cleanup(); } }, 25000);
      cleanup = () => { clearInterval(hb); unsub(); try { controller.close(); } catch { /* closed */ } };
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
