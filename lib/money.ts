/** All money is handled as integer cents internally; PayPal gets 2-decimal strings. */
export function toCents(v: string | number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${v}`);
  return Math.round(n * 100);
}
export function fromCents(c: number): string {
  return (c / 100).toFixed(2);
}
