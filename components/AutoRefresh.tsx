"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function AutoRefresh() {
  const router = useRouter();
  const [on, setOn] = useState(true);
  useEffect(() => { if (!on) return; const t = setInterval(() => router.refresh(), 5000); return () => clearInterval(t); }, [on, router]);
  return (
    <label className="flex items-center gap-2 text-sm text-mist">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Auto-refresh every 5s
    </label>
  );
}
