import { markVideoSentAction } from "@/app/ops/actions";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ ok: false, message: "Reload the hub before saving." }, { status: 403 });
  try { await requireAdmin(); } catch { return Response.json({ ok: false, message: "Sign in with an office account before recording delivery." }, { status: 403 }); }
  const me = await getCurrentUser();
  if (!me || me.impersonating) return Response.json({ ok: false, message: "Exit preview mode before recording delivery." }, { status: 403 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false, message: "Invalid delivery record." }, { status: 400 }); }
  if (typeof body?.submissionId !== "string" || body.submissionId.length > 200 || typeof body?.fingerprint !== "string" || body.fingerprint.length > 5000 || (body.notice !== undefined && (typeof body.notice !== "string" || body.notice.length > 30))) return Response.json({ ok: false, message: "Reopen this exact video's delivery record." }, { status: 400 });
  try { return Response.json(await markVideoSentAction(body.submissionId, body.notice, body.fingerprint)); }
  catch { return Response.json({ ok: false, unconfirmed: true, message: "Delivery record is unconfirmed." }, { status: 503 }); }
}
