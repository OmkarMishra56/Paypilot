import { prisma } from "@/lib/db";
import { maskId, resultLabel, sourceLabel, timeLabel } from "@/lib/activity";
import AutoRefresh from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";
export const metadata = { title: "PayPilot activity" };

export default async function Activity() {
  const logs: any[] = await prisma.toolLog.findMany({ orderBy: { createdAt: "desc" }, take: 150 });
  const hooks: any[] = await prisma.webhookLog.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  const th = "px-3 py-2 text-left font-semibold";
  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Activity log</h1>
          <p className="mt-1 text-sm text-mist">Every agent tool call and every PayPal API call, newest first. Emails are masked and ids are shortened. <a href="/" className="text-pay underline underline-offset-2">Back to chat</a></p>
        </div>
        <AutoRefresh />
      </div>

      <h2 className="mt-8 text-lg font-semibold">Calls</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-rule bg-white">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-rule bg-paper text-mist"><tr>
            <th className={th}>Time (UTC)</th><th className={th}>Source</th><th className={th}>Call</th><th className={th}>Result</th>
            <th className={th}>Request-Id</th><th className={th}>PayPal debug_id</th><th className={th}>PayPal id</th><th className={th}>Details</th>
          </tr></thead>
          <tbody className="divide-y divide-rule">
            {logs.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-mist">Nothing yet. Chat with the agent or run a checkout.</td></tr>}
            {logs.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{timeLabel(l.createdAt)}</td>
                <td className="whitespace-nowrap px-3 py-2">{sourceLabel(l.kind)}</td>
                <td className="px-3 py-2 font-medium">{l.name}</td>
                <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs font-medium ${l.ok ? "bg-good/10 text-good" : "bg-warn/10 text-warn"}`}>{resultLabel(l)}</span></td>
                <td className="px-3 py-2 text-mist">{maskId(l.requestId)}</td>
                <td className="px-3 py-2 text-mist">{l.debugId ?? ""}</td>
                <td className="px-3 py-2 text-mist">{l.paypalId ?? ""}</td>
                <td className="px-3 py-2 text-mist">{l.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-lg font-semibold">PayPal webhooks received</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border border-rule bg-white">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="border-b border-rule bg-paper text-mist"><tr><th className={th}>Time (UTC)</th><th className={th}>Event</th><th className={th}>Signature</th><th className={th}>Event id</th></tr></thead>
          <tbody className="divide-y divide-rule">
            {hooks.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-mist">No webhooks yet.</td></tr>}
            {hooks.map((h) => (
              <tr key={h.id}>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{timeLabel(h.createdAt)}</td>
                <td className="px-3 py-2 font-medium">{h.eventType}</td>
                <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs font-medium ${h.verified ? "bg-good/10 text-good" : "bg-warn/10 text-warn"}`}>{h.verified ? "verified" : "rejected"}</span></td>
                <td className="px-3 py-2 text-mist">{maskId(h.eventId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
