import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { markUploadedGroupSent } from "@/lib/projectDelivery";
import { isUploadedTarget, projectDeliveryHeaders } from "@/lib/uploadedDeliveryGroups";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ ok: false, completed: [], message: "Reload the hub before saving." }, { status: 403, headers });
  try { await requireAdmin(); } catch { return Response.json({ ok: false, completed: [], message: "Sign in with an office account before recording delivery." }, { status: 403, headers }); }
  const me = await getCurrentUser();
  if (!me || me.impersonating) return Response.json({ ok: false, completed: [], message: "Exit preview mode before recording delivery." }, { status: 403, headers });
  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false, completed: [], message: "Invalid delivery record." }, { status: 400, headers }); }
  if (typeof body?.projectId !== "string" || !body.projectId || body.projectId.length > 200 || !Array.isArray(body.cuts)
    || !body.cuts.length || body.cuts.length > 100 || !body.cuts.every(isUploadedTarget)) return Response.json({ ok: false, completed: [], message: "Reload this project's uploaded videos." }, { status: 400, headers });
  const started = Date.now();
  try {
    const result = await markUploadedGroupSent(body.projectId, body.cuts, me.name ?? me.email ?? "Office");
    console.info("project_delivery_acknowledgement", { ok: result.ok, completed: result.completed.length, elapsedMs: Date.now() - started });
    return Response.json(result, { headers: result.ok && typeof body.attemptId === "string" && /^[a-f0-9-]{36}$/i.test(body.attemptId)
      ? projectDeliveryHeaders(body.projectId, body.attemptId) : headers });
  } catch {
    console.error("project_delivery_acknowledgement_unconfirmed", { elapsedMs: Date.now() - started });
    return Response.json({ ok: false, completed: [], unconfirmed: true, message: "Delivery records are unconfirmed. Retry safely without sending the files again." }, { status: 503, headers });
  }
}
