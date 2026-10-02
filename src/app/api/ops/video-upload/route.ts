import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { recordUploaded } from "@/lib/deliveryUploads";

// Return the receipt directly; a dashboard render is not part of this save.
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ ok: false, message: "Reload the hub before saving." }, { status: 403 });
  }
  try { await requireAdmin(); } catch {
    return Response.json({ ok: false, message: "Sign in with an office account before marking uploads." }, { status: 403 });
  }
  const me = await getCurrentUser();
  if (!me || me.impersonating) return Response.json({ ok: false, message: "Exit preview mode before marking uploads." }, { status: 403 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false, message: "Invalid upload confirmation." }, { status: 400 }); }
  if (typeof body?.submissionId !== "string" || body.submissionId.length > 200 || typeof body?.fingerprint !== "string" || body.fingerprint.length > 5000) {
    return Response.json({ ok: false, message: "Reopen this video's current version." }, { status: 400 });
  }
  try {
    return Response.json(await recordUploaded(body.submissionId, { id: me.id, name: me.name ?? me.email ?? "Office" }, body.fingerprint));
  } catch {
    return Response.json({ ok: false, unconfirmed: true, message: "Could not confirm the upload record. Try Mark as Uploaded again; an existing record will be preserved." }, { status: 503 });
  }
}
