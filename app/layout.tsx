import "./globals.css";
export const metadata = { title: "PayPilot", description: "Chat-driven commerce on the PayPal sandbox" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body className="bg-paper text-ink antialiased">{children}</body></html>);
}
