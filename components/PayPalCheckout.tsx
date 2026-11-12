"use client";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import type { OrderView } from "@/lib/types";

export default function PayPalCheckout({ order, onApprove }: { order: OrderView; onApprove: (paypalOrderId: string) => Promise<void> }) {
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
  if (!clientId) return <p className="text-sm text-warn">Set NEXT_PUBLIC_PAYPAL_CLIENT_ID in .env and restart to show the PayPal buttons.</p>;
  return (
    <PayPalScriptProvider options={{ clientId, currency: "USD", intent: "capture" }}>
      <PayPalButtons
        key={order.paypalOrderId}
        style={{ layout: "vertical", shape: "rect", label: "pay" }}
        createOrder={async () => order.paypalOrderId!}
        onApprove={async (data) => { await onApprove(data.orderID); }}
        onError={(err) => console.error("PayPal button error", err)}
      />
    </PayPalScriptProvider>
  );
}
