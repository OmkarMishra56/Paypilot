import "dotenv/config";
import { seedDemoCart } from "../lib/demo";
import { cartView } from "../lib/cart";
(async () => {
  await seedDemoCart("demo-session");
  const c = await cartView("demo-session");
  console.log("Demo cart ready for session 'demo-session':", c.items.map((l) => `${l.qty}x ${l.name}`).join(", "), `($${(c.totalCents / 100).toFixed(2)})`);
  console.log("Open http://localhost:3000/?session=demo-session");
  process.exit(0);
})();
