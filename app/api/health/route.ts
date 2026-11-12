import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lightweight platform health check. Does not expose configuration or secrets. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", database: "ok" }, { status: 200 });
  } catch {
    return Response.json({ status: "error", database: "unavailable" }, { status: 503 });
  }
}
