import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { currentApproved, loadCut } from "@/lib/finalRendition";
import { chooseAryeoDelivery, destinationFingerprint, usesAryeoDelivery } from "@/lib/videoDeliveryDestination";
import { destinationReceiptHeaders } from "@/lib/videoDestinationReceipt";

const noStore = { "Cache-Control": "private, no-store" };
async function officeUser() {
  await requireAdmin();
  const me = await getCurrentUser();
  return me && !me.impersonating && ["OWNER", "ADMIN"].includes(me.role) ? me : null;
}
function valid(id: unknown, fingerprint: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 200 && typeof fingerprint === "string" && fingerprint.length > 0 && fingerprint.length <= 5000;
}

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ ok: false, message: "Reload the Hub before choosing a destination." }, { status: 403, headers: noStore });
  let me;
  try { me = await officeUser(); } catch { /* denied below */ }
  if (!me) return Response.json({ ok: false, message: "Use an office account and exit preview mode before changing delivery." }, { status: 403, headers: noStore });
  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false, message: "Invalid delivery choice." }, { status: 400, headers: noStore }); }
  if (!valid(body?.submissionId, body?.fingerprint)) return Response.json({ ok: false, message: "Reopen this finished version before choosing its destination." }, { status: 400, headers: noStore });
  try {
    const result = await chooseAryeoDelivery(body.submissionId, body.fingerprint, { id: me.id, name: me.name ?? me.email ?? "Office" });
    return Response.json(result, { status: result.ok ? 200 : 409, headers: result.ok ? destinationReceiptHeaders(body.submissionId, body.fingerprint) : noStore });
  } catch {
    return Response.json({ ok: false, unconfirmed: true, message: "Could not confirm the destination. Try again; any saved choice is preserved." }, { status: 503, headers: noStore });
  }
}

/** Read-only recovery if the save response is lost. */
export async function GET(request: Request) {
  try {
    if (!(await officeUser())) return Response.json({ ok: false }, { status: 403, headers: noStore });
    const params = new URL(request.url).searchParams;
    const id = params.get("submissionId"), fingerprint = params.get("fingerprint");
    if (!valid(id, fingerprint)) return Response.json({ ok: false }, { status: 400, headers: noStore });
    const cut = await loadCut(id);
    const saved = !!cut && destinationFingerprint(cut) === fingerprint && await currentApproved(cut) && await usesAryeoDelivery(cut);
    return Response.json({ ok: saved }, { headers: saved ? destinationReceiptHeaders(id, fingerprint!) : noStore });
  } catch { return Response.json({ ok: false }, { status: 503, headers: noStore }); }
}
