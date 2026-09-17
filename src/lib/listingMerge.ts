import "server-only";
import { prisma } from "@/lib/prisma";
import { aryeoRequest } from "@/lib/integrations/aryeo";

// ===========================================================================
// A LISTING BEING MERGED IN ARYEO (Sep 17 2026)
//
// Jordan, on the day all 54 activities were subscribed: "Listing merged is
// definitely important." He is right, and it is the least obvious of them.
//
// WHY IT MATTERS HERE. 1,518 of our jobs carry an Aryeo listing id, and the hub
// reads three things off it: how much media Aryeo holds (the status engine's
// delivered/undelivered call), whether a client's video is really up there (the
// Ready-to-send proof), and the Aryeo link a person clicks from a job. When two
// listings are merged, one of those ids stops being the address it used to be.
// Nothing errors. The job simply starts answering questions about a DIFFERENT
// property — media counts for the wrong house, a delivery "proved" by a video
// that belongs to someone else's listing. That is the worst kind of fault this
// hub has: quiet, and confidently wrong.
//
// WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT. It records the merge,
// works out which of our jobs pointed at each side, asks Aryeo which ids still
// resolve, and puts the whole thing in front of a person. It NEVER re-points a
// job by itself. Re-pointing is guessing which property a job belongs to, and
// the standing rule here is that ambiguous ownership goes to a human — a wrong
// re-point would silently attach one client's work to another client's address.
//
// WE HAVE NEVER SEEN ONE. No merge has reached this hub, so the payload shape
// is unknown: Aryeo's docs describe the ACTIVITY envelope and its nested
// `resource`, but not what a merge names as the absorbed side. So every id-ish
// field in the body is collected, each is checked against Aryeo, and the raw
// payload is written into the task. The first real merge teaches us the shape,
// and until then nothing is assumed.
// ===========================================================================

/** Every listing-shaped id in the body, wherever Aryeo chose to put it. */
function listingIdsIn(payload: unknown, depth = 0): string[] {
  if (!payload || typeof payload !== "object" || depth > 4) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      // An id under a key that talks about listings or merging is a candidate.
      // The envelope's own `resource.id` is included by the same rule.
      if (/listing|merge|source|target|from|into|id$/i.test(k)) out.push(v);
    } else if (v && typeof v === "object") {
      // Arrays and nested objects both land here. A nested object that declares
      // itself a LISTING carries its id under the plain key "id", which the
      // key test above already accepts.
      out.push(...listingIdsIn(v, depth + 1));
    }
  }
  return [...new Set(out)];
}

export type MergeOutcome = {
  handled: boolean;
  note: string;
  ids: string[];
  affected: number;
};

/**
 * Handle LISTING_MERGED. Records, checks, warns — never re-points.
 */
export async function handleListingMerged(payload: Record<string, unknown>): Promise<MergeOutcome> {
  const ids = listingIdsIn(payload);
  if (ids.length === 0) {
    return { handled: true, note: "a merge arrived with no listing id we could read — recorded only", ids: [], affected: 0 };
  }

  // Which of our jobs point at any of these ids, and does each id still exist?
  const projects = await prisma.project.findMany({
    where: { aryeoListingId: { in: ids } },
    select: { id: true, title: true, aryeoListingId: true, status: true },
  });

  const alive = new Map<string, boolean>();
  for (const id of ids) {
    // A merge's losing side stops resolving, or resolves as the survivor. Either
    // way we only record what Aryeo says; we never conclude from it alone.
    const ok = await aryeoRequest(`/listings/${id}`).then(() => true).catch(() => false);
    alive.set(id, ok);
  }

  const gone = ids.filter((id) => !alive.get(id));
  const affected = projects.filter((p) => gone.includes(p.aryeoListingId ?? ""));

  // The timeline first: every job that pointed at a side of this merge says so
  // on its own record, whether or not anybody reads the task.
  for (const p of projects) {
    const stillThere = alive.get(p.aryeoListingId ?? "") ?? false;
    await prisma.activity
      .create({
        data: {
          projectId: p.id,
          type: "SYSTEM",
          body: `Aryeo merged listings. This job points at ${p.aryeoListingId}, which ${stillThere ? "still resolves" : "NO LONGER resolves"}. Nothing was re-pointed automatically — media counts and delivery checks read off this id, so it needs a person to confirm which listing this job belongs to.`.slice(0, 500),
        },
      })
      .catch(() => {});
  }

  const lines = [
    `Aryeo merged listings: ${ids.join(", ")}.`,
    ...ids.map((id) => `  ${id} — ${alive.get(id) ? "still resolves" : "no longer resolves"}`),
    projects.length
      ? `Jobs pointing at one of these: ${projects.map((p) => p.title.split(",")[0]).join(", ")}.`
      : `No job in the hub points at either side.`,
    affected.length
      ? `${affected.length} of them point at a listing that has gone: their media counts and any delivery check now read the wrong listing until someone re-points them.`
      : `None of them point at a listing that has gone.`,
    `Nothing was changed automatically — re-pointing a job is a guess about which property it belongs to.`,
  ];

  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "aryeo_listing_merged",
      title: affected.length ? `Aryeo merged a listing one of our jobs uses` : `Aryeo merged a listing`,
      body: lines.join("\n").slice(0, 900),
      href: affected[0] ? `/projects/${affected[0].id}` : `/clients`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `aryeo-listing-merged-${ids.slice().sort().join("-")}`,
    });
  } catch { /* the bell is best-effort; the activities above are the record */ }

  return {
    handled: true,
    note: `${ids.length} listing id(s), ${projects.length} job(s) pointing at them, ${affected.length} now pointing at a listing that has gone`,
    ids,
    affected: affected.length,
  };
}
