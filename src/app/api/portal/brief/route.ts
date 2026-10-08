import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePortalViewer } from "@/lib/portal";
import { actorLabel, can, refusalMessage } from "@/lib/portalAccess";
import { addBriefFile } from "@/lib/monthBrief";
import { BRIEF_ID_RE, briefFileHref, briefFileRefusal, type BriefBy } from "@/lib/monthBriefCore";
import { mediaScopeOf, mediaToken, type MediaScope } from "@/lib/portalMedia";

export const runtime = "nodejs";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// ADD A FILE TO A MONTH'S CREATIVE BRIEF (Oct 8 2026). One door for both
// sides, and it authenticates itself (it is on the public list so a portal
// visit reaches it; the middleware does not vouch for anyone):
//
//   · a portal visit — the link's token in the form, or the signed-in
//     person's cookie — must resolve to the enrollment THIS month belongs to
//     and hold the "suggest" permission (an OWNER or COLLABORATOR seat on a
//     live program; a VIEWER, a paused/ended program or a revoked link are
//     refused);
//   · `as=staff` — the signed-in owner or admin (not "view as") adding a file
//     on the client's behalf from the client file.
//
// Type and size are checked before a byte is stored (monthBriefCore), a daily
// counter caps a leaked link, and the bytes go to the private Dropbox prefix
// (monthBrief.addBriefFile). A client's file bells the office; nothing is sent
// to the client.
// ---------------------------------------------------------------------------

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(req: NextRequest) {
  let form: FormData;
  try { form = await req.formData(); } catch { return json(400, { ok: false, message: "Bad upload." }); }
  const monthId = String(form.get("monthId") ?? "");
  if (!BRIEF_ID_RE.test(monthId)) return json(400, { ok: false, message: "Pick the month this brief is for." });
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, historical: true } });
  if (!month || month.historical) return json(404, { ok: false, message: "That month isn't open for a brief." });

  let by: BriefBy;
  /** A portal visit reads its file back through a scoped token (no hub session); staff read with their login. */
  let scope: MediaScope | null = null;
  if (String(form.get("as") ?? "") === "staff") {
    const { authEnforced } = await import("@/lib/auth/guards");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const u = await getCurrentUser().catch(() => null);
    if (authEnforced() && (!u || u.impersonating || (u.realRole !== "OWNER" && u.realRole !== "ADMIN"))) return json(403, { ok: false, message: "Only the owner or an admin can add a brief here." });
    by = { kind: "staff", label: u?.name || u?.email || "RealTour Pilot staff", id: u?.id ?? null };
  } else {
    const token = String(form.get("token") ?? "");
    const r = await resolvePortalViewer({ token: token || null, enrollmentId: String(form.get("enrollmentId") ?? "") || month.enrollmentId, cookies: req.cookies });
    if (!r.ok) return json(401, { ok: false, message: "This link is no longer active — sign in with your email to continue." });
    // THIS enrollment's month only: a valid link for one client never writes to another's.
    if (r.viewer.enrollment.id !== month.enrollmentId) return json(403, { ok: false, message: "That month isn't on your page." });
    if (!can(r.viewer, "suggest")) return json(403, { ok: false, message: refusalMessage(r.viewer, "suggest") });
    const a = r.viewer.actor;
    scope = mediaScopeOf(r.viewer);
    by = { kind: a.kind === "STAFF" ? "staff" : "client", label: actorLabel(r.viewer), id: a.kind === "CLIENT" ? a.clientUserId : a.kind === "STAFF" ? a.staffUserId : null };
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { ok: false, message: "Pick a file first." });
  const refusal = briefFileRefusal(file.name, file.size);
  if (refusal) return json(file.size > 0 && /over/.test(refusal) ? 413 : 400, { ok: false, tooBig: /over/.test(refusal), message: refusal });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await addBriefFile(month.id, { name: file.name, size: file.size, bytes }, by);
  if (!r.ok || !r.file) return json(400, { ok: false, message: r.message });
  const href = briefFileHref(month.id, r.file.id) + (scope ? `?m=${encodeURIComponent(mediaToken(r.file.id, scope))}` : "");
  return json(200, { ok: true, message: r.message, file: { id: r.file.id, name: r.file.name, size: r.file.size, byKind: r.file.by.kind, byLabel: r.file.by.label, atISO: r.file.atISO, href } });
}
