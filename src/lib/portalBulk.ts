import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE CLIENT'S VIEW OF A BULK PLAN (Oct 15 2026). Jordan: "I want him to be
// able to have access to the scripts and be able to see the scripts so that
// he can view each one. I want them grouped per session, but be able to go
// into the next session and see the scripts for that one too, and also mark
// them complete so we can keep track of which ones are getting done."
//
// Read-only over bulkPlan.bulkBoard; the words are the version RELEASED to
// the client (postingKit.scriptVisibility), never a draft. "Filmed", "Being
// edited" and "Ready" come from the upload portal and the review pipeline;
// the client's own "Done" tick sits beside them and never replaces them.
// ---------------------------------------------------------------------------

export type PortalBulkItem = {
  scriptId: string | null;
  no: number;
  title: string;
  pillar: string | null;
  /** What the client reads on the chip. */
  state: "to_film" | "marked_done" | "filmed" | "editing" | "in_review" | "delivered";
  markedDone: boolean;
  /** The released words, or null while the script is not on the portal yet. */
  body: string | null;
  captionCta: string | null;
};
export type PortalBulkSession = { no: number; dateISO: string | null; booked: boolean; items: PortalBulkItem[]; done: number };
export type PortalBulkView = {
  title: string | null;
  total: number;
  perSession: number;
  sessions: PortalBulkSession[];
  /** The session to open first: the next one with scripts still to film. */
  focusSessionNo: number | null;
  totals: { planned: number; filmed: number; delivered: number; markedDone: number };
  /** Every script in one PDF (Oct 19 2026): set by the portal page, which mints the viewer's own link. */
  pdfHref?: string | null;
};

const STATE: Record<string, PortalBulkItem["state"]> = {
  planned: "to_film", client_done: "marked_done", filmed: "filmed", editing: "editing", in_review: "in_review", delivered: "delivered",
};

/** Null when the client has no bulk plan (every monthly client). */
export async function portalBulkView(enrollmentId: string): Promise<PortalBulkView | null> {
  const { latestBulkPlanFor, bulkBoard } = await import("@/lib/bulkPlan");
  const plan = await latestBulkPlanFor(enrollmentId);
  if (!plan) return null;
  const board = await bulkBoard(plan.id);
  if (!board) return null;
  const items = board.sessions.flatMap((s) => s.items);
  const scriptIds = items.map((x) => x.scriptId).filter((x): x is string => !!x);
  const scripts = scriptIds.length
    ? await prisma.contentScript.findMany({ where: { id: { in: scriptIds }, enrollmentId }, select: { id: true, status: true, releaseState: true, historical: true, sharedVersionId: true } })
    : [];
  const { scriptVisibility } = await import("@/lib/postingKit");
  const shownVersion = new Map<string, string>();
  for (const s of scripts) if (s.sharedVersionId && scriptVisibility(s) === "released") shownVersion.set(s.id, s.sharedVersionId);
  const versions = shownVersion.size
    ? await prisma.contentScriptVersion.findMany({ where: { id: { in: [...shownVersion.values()] } }, select: { id: true, body: true, captionCta: true } })
    : [];
  const versionOf = new Map(versions.map((v) => [v.id, v]));
  let n = 0;
  const sessions: PortalBulkSession[] = board.sessions
    .filter((s) => s.items.length > 0 || s.booked)
    .map((s) => ({
      no: s.no,
      dateISO: s.dateISO,
      booked: s.booked,
      items: s.items.map((x) => {
        n++;
        const v = x.scriptId ? versionOf.get(shownVersion.get(x.scriptId) ?? "") : undefined;
        return {
          scriptId: x.scriptId && shownVersion.has(x.scriptId) ? x.scriptId : null,
          no: n,
          title: x.title,
          pillar: x.pillar,
          state: STATE[x.state] ?? "to_film",
          markedDone: !!x.clientMarkedDoneAtISO,
          body: v?.body ?? null,
          captionCta: v?.captionCta ?? null,
        };
      }),
      done: s.items.filter((x) => x.state !== "planned").length,
    }));
  return {
    title: board.plan.title,
    total: board.plan.totalVideos,
    perSession: board.plan.perSession,
    sessions,
    focusSessionNo: board.nextSessionNo ?? sessions.at(-1)?.no ?? null,
    totals: { planned: board.totals.planned, filmed: board.totals.filmed, delivered: board.totals.delivered, markedDone: board.totals.clientDone },
  };
}
