import { NextRequest, NextResponse } from "next/server";
import { syncAryeoSocialPlans, syncAllAryeoClients, syncAryeoAppointments, syncAryeoCustomerTeams } from "@/lib/integrations/aryeo";
import { syncClientSegments } from "@/lib/segmentSync";
import { dedupeClients } from "@/lib/clientDedupe";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// DAILY cron — the heavy, full-table maintenance jobs that scan every client /
// customer-user. Run once a day (not every tick) to keep Neon data transfer low.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  try { out.clients = await syncAllAryeoClients(); } catch (e) { out.clientsError = e instanceof Error ? e.message : String(e); }
  try { out.dedupe = await dedupeClients(); } catch (e) { out.dedupeError = e instanceof Error ? e.message : String(e); }
  try { out.segments = await syncClientSegments(); } catch (e) { out.segmentError = e instanceof Error ? e.message : String(e); }
  try { out.social = await syncAryeoSocialPlans(); } catch (e) { out.socialError = e instanceof Error ? e.message : String(e); }
  // Fold agency-team assistants under their agent so comms route to the orders.
  try { out.customerTeams = await syncAryeoCustomerTeams(); } catch (e) { out.customerTeamsError = e instanceof Error ? e.message : String(e); }
  // Full appointments reconcile once a day (the hourly cron only does recent+future).
  try { out.appointments = await syncAryeoAppointments(); } catch (e) { out.appointmentsError = e instanceof Error ? e.message : String(e); }
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = await prisma.webhookEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    out.webhookLogTrimmed = r.count;
  } catch { /* non-fatal */ }
  return NextResponse.json({ ok: true, ...out });
}
