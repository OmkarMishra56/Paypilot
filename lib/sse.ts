import type { PushEvent } from "./types";
type Listener = (e: PushEvent) => void;
// globalThis: Next compiles each route into its own bundle, so a module-level Map would not be shared.
const g = globalThis as unknown as { __paypilotSubs?: Map<string, Set<Listener>> };
const subs: Map<string, Set<Listener>> = (g.__paypilotSubs ??= new Map());

export function subscribe(sessionId: string, fn: Listener): () => void {
  if (!subs.has(sessionId)) subs.set(sessionId, new Set());
  subs.get(sessionId)!.add(fn);
  return () => { subs.get(sessionId)?.delete(fn); };
}
export function publish(sessionId: string, e: PushEvent) {
  subs.get(sessionId)?.forEach((fn) => { try { fn(e); } catch { /* dead listener */ } });
}
