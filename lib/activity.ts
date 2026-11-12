export const maskId = (s?: string | null) => (!s ? "" : s.length <= 10 ? s : `${s.slice(0, 8)}…`);
export const resultLabel = (l: { ok: boolean; httpStatus?: number | null }) => (l.httpStatus ? String(l.httpStatus) : l.ok ? "ok" : "failed");
export const sourceLabel = (kind: string) => (kind === "paypal" ? "PayPal API" : "Agent tool");
export const timeLabel = (d: Date | string) => new Date(d).toISOString().slice(11, 19) + "Z";
