"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { resolvePortalViewer } from "@/lib/portal";
import { actorLabel, can, refusalMessage } from "@/lib/portalAccess";
import { requireAdmin } from "@/lib/auth/guards";
import { briefFileFor, removeBriefFile, saveBriefNotes } from "@/lib/monthBrief";
import { BRIEF_ID_RE, type BriefBy } from "@/lib/monthBriefCore";
import type { PortalAuth } from "@/app/portal/actions";

// ---------------------------------------------------------------------------
// THE MONTH'S CREATIVE BRIEF — notes and removal (Oct 8 2026). Files arrive
// through /api/portal/brief (a server action's body limit is too small for a
// document); everything else is here, for both sides:
//   · the client (portal): the visit must resolve to the enrollment THIS month
//     belongs to and hold "suggest"; a client removes only what a client added;
//   · staff (the client file): owner/admin, never "view as".
// Nothing here messages the client. A client's notes bell the office
// (monthBrief.saveBriefNotes).
// ---------------------------------------------------------------------------

type R = { ok: boolean; message: string };

async function portalBy(auth: PortalAuth, monthId: string): Promise<{ by: BriefBy; enrollmentId: string } | string> {
  if (!BRIEF_ID_RE.test(monthId ?? "")) return "Pick the month this brief is for.";
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true, historical: true } });
  if (!month || month.historical) return "That month isn't open for a brief.";
  const r = await resolvePortalViewer({ token: auth?.token ?? null, enrollmentId: auth?.enrollmentId ?? month.enrollmentId });
  if (!r.ok) return r.reason === "no_session" || r.reason === "no_membership" ? "Please sign in to do that." : "This link is no longer active — sign in with your email to continue.";
  if (r.viewer.enrollment.id !== month.enrollmentId) return "That month isn't on your page.";
  if (!can(r.viewer, "suggest")) return refusalMessage(r.viewer, "suggest");
  const a = r.viewer.actor;
  return { enrollmentId: month.enrollmentId, by: { kind: a.kind === "STAFF" ? "staff" : "client", label: actorLabel(r.viewer), id: a.kind === "CLIENT" ? a.clientUserId : a.kind === "STAFF" ? a.staffUserId : null } };
}

export async function portalSaveBriefNotes(auth: PortalAuth, monthId: string, text: string): Promise<R> {
  const v = await portalBy(auth, monthId);
  if (typeof v === "string") return { ok: false, message: v };
  const r = await saveBriefNotes(monthId, String(text ?? ""), v.by);
  return { ok: r.ok, message: r.message };
}

export async function portalRemoveBriefFile(auth: PortalAuth, monthId: string, fileId: string): Promise<R> {
  const v = await portalBy(auth, monthId);
  if (typeof v === "string") return { ok: false, message: v };
  const hit = await briefFileFor(monthId, String(fileId ?? ""));
  if (!hit) return { ok: false, message: "That file isn't on this brief." };
  // A client takes back what a client added; a file our team added stays until we remove it.
  if (v.by.kind === "client" && hit.file.by.kind !== "client") return { ok: false, message: "Our team added that file — ask us in Messages if it should go." };
  const r = await removeBriefFile(monthId, hit.file.id);
  return { ok: r.ok, message: r.message };
}

async function staffBy(): Promise<BriefBy> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const u = await getCurrentUser().catch(() => null);
  return { kind: "staff", label: u?.name || u?.email || "RealTour Pilot staff", id: u?.id ?? null };
}

async function touch(monthId: string) {
  const m = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true } }).catch(() => null);
  if (m) revalidatePath(`/content/${m.enrollmentId}`);
}

export async function staffSaveBriefNotes(monthId: string, text: string): Promise<R> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Not allowed." }; }
  const r = await saveBriefNotes(String(monthId ?? ""), String(text ?? ""), await staffBy());
  if (r.ok) await touch(monthId);
  return { ok: r.ok, message: r.message };
}

export async function staffRemoveBriefFile(monthId: string, fileId: string): Promise<R> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Not allowed." }; }
  const r = await removeBriefFile(String(monthId ?? ""), String(fileId ?? ""));
  if (r.ok) await touch(monthId);
  return { ok: r.ok, message: r.message };
}
