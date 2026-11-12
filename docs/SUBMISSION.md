# PayPilot — reviewer walkthrough

## One-line summary

PayPilot is a chat-first commerce agent that can discover products and orchestrate PayPal checkout, invoicing, and refunds while keeping every money-moving action behind explicit human confirmation.

## Suggested 4–6 minute demo

1. **Open the app.** Show the chat, cart panel, PayPal sandbox label, and `/activity` link.
2. **Discover products.** Ask for a product recommendation with a budget. Point out that the agent uses the product-search tool and catalog data rather than inventing an item.
3. **Build a cart.** Ask the agent to add a selected item and show the cart total.
4. **Start checkout.** Ask to check out. Explain that order creation does not itself capture payment; the buyer must approve with the PayPal sandbox UI.
5. **Confirm capture.** After approval, show the separate confirmation dialog. Emphasize that the capture endpoint is not called until the shopper confirms.
6. **Inspect activity.** Open `/activity` and show the agent tool call, PayPal API result, request ID/debug ID (when returned), and webhook verification status.
7. **Explain an order.** Ask “Explain this order.” The response is constrained to the recorded event timeline. If a refund reason was not stored, the agent should say it is not recorded.
8. **Optional refund/invoice flow.** Use a sandbox order and demonstrate that refund/invoice actions also require the confirmation dialog. Do not attempt a real-money transaction.

## Engineering points to call out

- Tool arguments are validated with Zod before execution.
- The agent is not given direct access to payment credentials; PayPal calls are centralized in server-side `lib/paypal.ts`.
- Capture, invoice send, and refund use a one-time confirmation record with expiry and server-side state validation.
- PayPal write requests use `PayPal-Request-Id` idempotency keys.
- Refund logic checks the remaining refundable balance again immediately before calling PayPal.
- Webhook signatures are verified with PayPal before event processing; duplicate event IDs are ignored.
- Order explanations are built from database events and verified webhook records rather than free-form model speculation.
- Activity logs redact email addresses and opaque bearer tokens before display.

## Demo prerequisites

- App dependencies installed and Prisma database prepared.
- LLM provider key configured.
- PayPal sandbox app credentials configured.
- PayPal sandbox buyer account available for checkout approval.
- Webhook ID configured if demonstrating webhook delivery.

## Claims to avoid

- Do not describe the app as production-ready or suitable for live payments.
- Do not claim a webhook was received or verified unless it appears in the activity dashboard.
- Do not claim an order was paid or refunded unless PayPal and the app's persisted status confirm it.
- Do not claim the project has been externally penetration-tested or load-tested.
