// Run after filling .env:  npm run smoke:paypal
import "dotenv/config";
import { createOrder } from "../lib/paypal";
(async () => {
  const o = await createOrder([{ name: "Smoke test item", unitCents: 1000, qty: 1 }]);
  console.log("Order:", o.id, o.status, "\nOpen as the sandbox BUYER to approve:", o.approveUrl);
})().catch((e) => { console.error("FAILED:", e.message, "debug_id:", e.debugId); process.exit(1); });
