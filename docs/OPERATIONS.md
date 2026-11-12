# Operations and verification checklist

## Before a demo

- [ ] Confirm `.env` exists locally and is not tracked by Git.
- [ ] Confirm PayPal credentials are sandbox credentials.
- [ ] Confirm the LLM provider and model are configured.
- [ ] Run `npm ci`, `npx prisma db push`, `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Open `/api/health` and confirm the database check is healthy.
- [ ] Seed a demo cart if useful with `npm run seed:demo`.
- [ ] Use a PayPal sandbox buyer account, not a personal/live account.

## Environment variable handling

- Keep `.env` out of Git, ZIP submissions, screenshots, and issue trackers.
- Use `.env.example` only as a template; it must contain placeholders, never real keys.
- Store deployment secrets in the hosting provider's environment-variable manager.
- If a credential was ever committed, pasted into a public issue, or shared in an archive, rotate it at the provider. Removing it from the latest commit does not invalidate the exposed credential.

## Render notes

- The included Blueprint uses one web instance and a persistent disk mounted at `/var/data`.
- `DATABASE_URL` must remain `file:/var/data/paypilot.db` for that service unless the disk mount or database strategy is intentionally changed.
- Do not scale the SQLite-backed service to multiple instances.
- Back up the persistent database before destructive schema changes.
- The start command applies the Prisma schema with `prisma db push`; review schema changes before deploying them.

## Endpoint checks

| Endpoint | Expected purpose |
|---|---|
| `GET /api/health` | Reports application/database health without exposing secrets |
| `GET /activity` | Displays recent agent, PayPal, and webhook activity |
| `POST /api/paypal/webhook` | Accepts PayPal webhook events after signature verification |

## External test cases

1. Search the catalog and add a valid product.
2. Attempt an invalid product ID; it should return a controlled tool error.
3. Create a PayPal sandbox order and approve it with a sandbox buyer.
4. Close/cancel the capture confirmation; verify no capture is recorded.
5. Reopen and confirm capture; verify the order status and activity record.
6. Request a refund larger than the remaining refundable amount; the server should reject it.
7. Confirm a valid partial refund; verify the remaining refundable balance.
8. Deliver a valid webhook and verify it is logged; send a duplicate event and verify it is treated as a duplicate.
9. Deliver an invalid-signature event; verify it is rejected and does not mutate the order.
10. Ask why an order was refunded when no reason was recorded; the agent should state that the reason is not recorded.
