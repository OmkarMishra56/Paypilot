import products from "../data/products.json";

interface RawProduct { id: string; name: string; description: string; priceCents: number; category: string; tags: string[] }
export interface Product extends RawProduct { price: string }
/** `price` is the USD display string ("24.00"); `priceCents` is authoritative. */
export const CATALOG: Product[] = (products as RawProduct[]).map((p) => ({ ...p, price: (p.priceCents / 100).toFixed(2) }));

export const getProduct = (id: string) => CATALOG.find((p) => p.id === id);

export function searchProducts(query: string, maxPrice?: number, limit = 8): Product[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !["a", "an", "the", "for", "me", "find", "some", "under", "and", "with", "bill", "my"].includes(t));
  const cap = maxPrice === undefined ? Infinity : Math.round(maxPrice * 100);
  return CATALOG
    .filter((p) => p.priceCents <= cap)
    .map((p) => {
      const hay = `${p.name} ${p.description} ${p.category} ${p.tags.join(" ")}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? (p.tags.includes(t) || p.category === t ? 2 : 1) : 0), 0);
      return { p, score };
    })
    .filter((x) => terms.length === 0 || x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.priceCents - b.p.priceCents)
    .slice(0, limit)
    .map((x) => x.p);
}
