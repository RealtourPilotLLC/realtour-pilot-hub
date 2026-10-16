import "server-only";
import { prisma } from "@/lib/prisma";
import {
  CREATIVE_GUARD_KEY, creativeGuardFromOverrides, normalizeGuard, seriesKey,
  type CreativeGuard,
} from "@/lib/creativeGuardCore";

// ---------------------------------------------------------------------------
// A CLIENT'S CREATIVE GUARDRAILS AND STYLE MEMORY, SERVER HALF (Oct 15 2026).
// The record and the matching rule are in creativeGuardCore.ts.
//
//   setCreativeGuard   staff write: compare-and-swap on the whole overrides
//                      bag (the catch-up, late-session and video-style records
//                      share it), and a ProgramEnrollmentChange row for every
//                      save, like every other program setting.
//   styleMemoryFor     what the editor brief and the Review Room show about
//                      the client's style: the guardrails, their example
//                      videos (EXAMPLE_VIDEO assets) and their last three
//                      approved videos from other jobs.
// Nothing here messages a client.
// ---------------------------------------------------------------------------

export async function creativeGuardForEnrollment(enrollmentId: string): Promise<CreativeGuard> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  return creativeGuardFromOverrides(e?.overridesJson ?? null);
}

export async function creativeGuardForClient(clientId: string): Promise<CreativeGuard | null> {
  const e = await prisma.contentEnrollment.findUnique({ where: { clientId }, select: { overridesJson: true } }).catch(() => null);
  return e ? creativeGuardFromOverrides(e.overridesJson) : null;
}

export type GuardPatch = {
  provenFormats?: string[];
  experimentCap?: number | null;
  addDiscontinued?: { name: string; reason?: string | null } | null;
  removeDiscontinued?: string | null;
};

/** Save a change to the guardrails. Returns plain words for the screen. */
export async function setCreativeGuard(enrollmentId: string, patch: GuardPatch, by: string | null, now: Date = new Date()): Promise<{ ok: boolean; message: string; guard?: CreativeGuard }> {
  const { readOverrides, recordEnrollmentChange } = await import("@/lib/enrollmentChanges");
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, overridesJson: true } });
    if (!e) return { ok: false, message: "That program no longer exists." };
    const before = creativeGuardFromOverrides(e.overridesJson);
    const next: CreativeGuard = { ...before, provenFormats: [...before.provenFormats], discontinued: [...before.discontinued] };
    if (patch.provenFormats) next.provenFormats = patch.provenFormats.map((f) => f.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10);
    if (patch.experimentCap !== undefined) {
      if (patch.experimentCap !== null && !(Number.isInteger(patch.experimentCap) && patch.experimentCap >= 0 && patch.experimentCap <= 20)) {
        return { ok: false, message: "The experiment limit is a whole number from 0 to 20, or blank for no rule." };
      }
      next.experimentCap = patch.experimentCap;
    }
    if (patch.addDiscontinued) {
      const name = patch.addDiscontinued.name.replace(/\s+/g, " ").trim().slice(0, 120);
      if (seriesKey(name).length < 3) return { ok: false, message: "Name the series or concept to stop." };
      if (next.discontinued.some((d) => seriesKey(d.name) === seriesKey(name))) return { ok: false, message: `"${name}" is already stopped.` };
      next.discontinued.push({ name, by, at: now.toISOString(), reason: patch.addDiscontinued.reason?.trim().slice(0, 400) || null });
    }
    if (patch.removeDiscontinued) {
      const k = seriesKey(patch.removeDiscontinued);
      next.discontinued = next.discontinued.filter((d) => seriesKey(d.name) !== k);
    }
    next.updatedBy = by;
    next.updatedAt = now.toISOString();
    const clean = normalizeGuard(next);
    const bag = { ...readOverrides(e.overridesJson) };
    const empty = clean.provenFormats.length === 0 && clean.discontinued.length === 0 && clean.experimentCap == null;
    if (empty) delete bag[CREATIVE_GUARD_KEY]; else bag[CREATIVE_GUARD_KEY] = clean;
    const json = Object.keys(bag).length ? JSON.stringify(bag) : null;
    const w = await prisma.contentEnrollment.updateMany({ where: { id: enrollmentId, overridesJson: e.overridesJson }, data: { overridesJson: json } });
    if (!w.count) continue;
    const { etMonthKey } = await import("@/lib/contentProgram");
    const what = patch.addDiscontinued ? `Stopped "${patch.addDiscontinued.name.trim()}"` : patch.removeDiscontinued ? `Brought back "${patch.removeDiscontinued}"` : "Creative guardrails updated";
    await recordEnrollmentChange({
      enrollmentId, clientId: e.clientId, field: "overrides", from: { [CREATIVE_GUARD_KEY]: before }, to: { [CREATIVE_GUARD_KEY]: empty ? null : clean },
      effectiveAt: now, effectiveMonthKey: etMonthKey(now), changedBy: by, appliedAt: now, reason: `${what} (creative guardrails).`,
    });
    return { ok: true, message: `${what}.`, guard: clean };
  }
  return { ok: false, message: "The client file changed while saving. Try again." };
}

export type StyleMemory = {
  guard: CreativeGuard | null;
  /** EXAMPLE_VIDEO assets on the client's brand registry */
  examples: { name: string; url: string | null; text: string | null }[];
  /** the client's last approved videos from OTHER jobs, newest first */
  recentVideos: { title: string; url: string; approvedAtISO: string | null }[];
};

/**
 * What the editor and the reviewer see of the client's style beyond the brand
 * kit. `forProjectId`: the job being worked, left out of the recent list and
 * carried on each link so an editor holding that job may play the client's
 * other APPROVED videos (the stream route's `ref` rule) and nothing else.
 */
export async function styleMemoryFor(clientId: string, opts: { forProjectId?: string | null; registry?: { type: string; name: string; status: string; active: { url: string | null; valueText: string | null; cleared: boolean } | null }[] } = {}): Promise<StyleMemory> {
  const guard = await creativeGuardForClient(clientId).catch(() => null);
  const registry = opts.registry ?? (await import("@/lib/clientAssets").then((m) => m.assetRegistry(clientId, { links: true })).catch(() => []));
  const examples = registry
    .filter((a) => a.type === "EXAMPLE_VIDEO" && a.status === "ACTIVE" && a.active && !a.active.cleared)
    .map((a) => {
      const text = a.active!.valueText?.trim() || null;
      const url = a.active!.url ?? (text && /^https?:\/\//i.test(text) ? text : null);
      return { name: a.name, url, text: url === text ? null : text };
    })
    .slice(0, 6);
  const cuts = await prisma.reviewSubmission.findMany({
    where: {
      status: "APPROVED", kind: "video", withdrawnAt: null,
      project: { clientId, status: { not: "CANCELLED" } },
      ...(opts.forProjectId ? { projectId: { not: opts.forProjectId } } : {}),
    },
    orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
    take: 3,
    select: { id: true, fileName: true, decidedAt: true, project: { select: { title: true } } },
  }).catch(() => []);
  const ref = opts.forProjectId ? `?ref=${encodeURIComponent(opts.forProjectId)}` : "";
  const recentVideos = cuts.map((c) => ({
    title: `${(c.project?.title ?? "A job").split(",")[0].trim()}${c.fileName ? ` · ${c.fileName}` : ""}`,
    url: `/api/review/cut/${c.id}/stream${ref}`,
    approvedAtISO: c.decidedAt?.toISOString() ?? null,
  }));
  return { guard, examples, recentVideos };
}
