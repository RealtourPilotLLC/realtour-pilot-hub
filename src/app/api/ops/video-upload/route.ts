import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { recordUploaded, uploadReceiptStatus } from "@/lib/deliveryUploads";
import { uploadReceiptHeaders } from "@/lib/uploadReceiptResponse";

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
  const started = Date.now();
  try {
    const result = await recordUploaded(body.submissionId, { id: me.id, name: me.name ?? me.email ?? "Office" }, body.fingerprint);
    console.info("video_upload_acknowledgement", { ok: result.ok, elapsedMs: Date.now() - started });
    return Response.json(result, { headers: result.ok ? uploadReceiptHeaders(body.submissionId, body.fingerprint) : { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("video_upload_acknowledgement_unconfirmed", { elapsedMs: Date.now() - started, code: typeof error === "object" && error && "code" in error ? String(error.code) : "unknown" });
    return Response.json({ ok: false, unconfirmed: true, message: "Could not confirm the upload record. Try Mark as Uploaded again; an existing record will be preserved." }, { status: 503 });
  }
}


// Authenticated, uncached, read-only recovery after a lost save response.
export async function GET(request: Request) {
  try { await requireAdmin(); } catch { return Response.json({ ok: false, message: "Sign in with an office account before checking uploads." }, { status: 403 }); }
  try {
    const me = await getCurrentUser();
    if (!me || me.impersonating) return Response.json({ ok: false, message: "Exit preview mode before checking uploads." }, { status: 403 });
    const query = new URL(request.url).searchParams;
    const id = query.get("submissionId"), fingerprint = query.get("fingerprint");
    if (!id || id.length > 200 || !fingerprint || fingerprint.length > 5000) return Response.json({ ok: false, message: "Reopen this video's current version." }, { status: 400 });
    const result = await uploadReceiptStatus(id, fingerprint);
    return Response.json(result, { headers: result.recorded ? uploadReceiptHeaders(id, fingerprint, "sent" in result && result.sent === true) : { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ ok: false, unconfirmed: true, message: "The saved upload receipt could not be checked." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
