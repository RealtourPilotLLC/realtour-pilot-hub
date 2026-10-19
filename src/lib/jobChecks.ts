import "server-only";
import { ActivityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clip, scrubMoney, stripMoneySentences } from "@/lib/text";

// ---------------------------------------------------------------------------
// "BEFORE YOU SEND" (Oct 19 2026). Jordan: "Flagged by 'Creative' should be on
// each photo or video job so that no matter where we are, we see what was
// flagged at that shoot before sending it out or before. Same with the edit
// notes or special requests etc."
//
// One read per job and medium; every job surface (the photo job page, the
// editor brief, the Review Room cut page, the Ready to send rows) renders it
// the same way (components/jobs/BeforeYouSend). Three parts, only what exists:
//   · FLAGGED AT THE SHOOT: the creative's own flags on this job (the FLAG
//     rows the field screens write: "Flag a problem", the debrief's "had
//     issues", a missed shot) that are about the work, sorted with the same
//     word rule that sends them to Kyle (shootIssues.sortShootFlag). A flag
//     about the shoot itself went to Jordan only and is not shown here. Photo
//     flags show on the photo box, video flags on the video box; delivery and
//     unclear ones on both.
//   · CLIENT REQUESTS: the client's open special requests for this medium
//     (texts, emails, calls, or typed by staff for them; both / unclear count
//     for either), with ONE "Checked" for all of them (jobs/actions).
//   · NOTES: what the order and the job already say, one line each: the
//     customer's note on the Aryeo order (codes, lockboxes and "who meets
//     whom" left out), add-ons to check (Lot Lines...), the office's note, the
//     photographer's notes, the video notes (video) or what to remove (photos).
// Money never shows to anyone but the owner (a client's "under $350k" reads
// "under [amount]" for Kyle); a code or a lockbox never shows to anyone.
// ---------------------------------------------------------------------------

export type JobMedium = "photo" | "video";

export type JobCheckFlag = { id: string; text: string; by: string | null; atISO: string; about: "photo" | "video" | "delivery" | "both" };
export type JobCheckRequest = { id: string; summary: string; text: string; askedBy: string | null; askedAtISO: string; medium: string | null };
export type JobChecks = {
  projectId: string;
  /** Flagged at the shoot, about the photos, the video or delivery. */
  flags: JobCheckFlag[];
  /** The client's open special requests (texts, emails, calls) for this medium. */
  requests: JobCheckRequest[];
  /** Order notes and edit notes, plain lines. */
  notes: { label: string; text: string }[];
  /** Open client requests that must be checked before this medium is sent. */
  openRequests: number;
  /** The last "Checked" on this job's requests for this medium, in the last week (who, when, how many). */
  checked?: { by: string; atISO: string; count: number } | null;
};

const empty = (projectId: string): JobChecks => ({ projectId, flags: [], requests: [], notes: [], openRequests: 0, checked: null });

/** A note's sentences without a code, a lockbox or a key. */
function withoutAccess(text: string, isAccessNote: (s: string) => boolean): string {
  return text
    .split("\n")
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => s.trim() && !isAccessNote(s)).join(" "))
    .filter((l) => l.trim())
    .join("\n")
    .trim();
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** "Shoot debrief — had issues: x" reads "After the shoot: x"; the rest as written. */
function flagLine(body: string): string {
  return oneLine(body.replace(/^Shoot debrief\s*[—-]\s*had issues\s*:\s*/i, "After the shoot: ").replace(/\s+[—–]\s+/g, ", "));
}

export async function jobChecks(projectId: string, medium: JobMedium): Promise<JobChecks> {
  if (!projectId) return empty(projectId);
  try {
    const { jobRequests, orderAskCandidates, mediumMatches, viewerSeesMoney, ASK_SOURCES } = await import("@/lib/clientAsks");
    const [seesMoney, p, requests, lastChecked] = await Promise.all([
      viewerSeesMoney(),
      prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true, clientId: true, notes: true, editorBrief: true, videoInstructions: true, removalNotes: true, createdAt: true,
          photographer: { select: { name: true } },
          client: { select: { name: true } },
          appointments: { orderBy: { startAt: "asc" }, select: { aryeoId: true, description: true, createdAt: true } },
          orderItems: { select: { title: true, isCanceled: true } },
          deliverables: { select: { productTitle: true, removedFromOrderAt: true } },
          activities: { where: { type: ActivityType.FLAG }, orderBy: { createdAt: "asc" }, take: 60, select: { id: true, body: true, createdAt: true, author: { select: { name: true } } } },
        },
      }),
      jobRequests(projectId, medium),
      prisma.clientAsk.findMany({
        where: { projectId, kind: "SPECIAL_REQUEST", state: "CONFIRMED", source: { in: [...ASK_SOURCES] }, confirmedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        orderBy: { confirmedAt: "desc" },
        take: 40,
        select: { confirmedAt: true, confirmedBy: true, medium: true },
      }),
    ]);
    if (!p) return empty(projectId);
    // The owner sees every word; anyone else sees no amount (a client's "under
    // $350k" reads "under [amount]"), and a note loses our own billing lines.
    const money = (s: string) => (seesMoney ? s : scrubMoney(s));
    const moneyNote = (s: string) => (seesMoney ? s : scrubMoney(stripMoneySentences(s)));

    // ---- flagged at the shoot ----
    const [{ isFieldFlag }, { sortShootFlag, isJobFlag }, { isAccessNote }] = await Promise.all([import("@/lib/debrief"), import("@/lib/shootIssues"), import("@/lib/specialRequests")]);
    const flags: JobCheckFlag[] = [];
    for (const a of p.activities) {
      if (!isFieldFlag(a.body)) continue;
      const sorted = sortShootFlag(a.body);
      if (!isJobFlag(sorted.route)) continue;
      if (!(sorted.about === medium || sorted.about === "both" || sorted.about === "delivery")) continue;
      const text = withoutAccess(flagLine(a.body), isAccessNote);
      if (!text) continue;
      flags.push({ id: a.id, text: clip(money(text), 400), by: a.author?.name ?? p.photographer?.name ?? null, atISO: a.createdAt.toISOString(), about: sorted.about });
    }

    // ---- client requests ----
    const reqs: JobCheckRequest[] = requests.map((r) => ({
      id: r.id,
      summary: money(r.summary),
      text: money(r.text),
      askedBy: r.askedBy,
      askedAtISO: r.askedAt.toISOString(),
      medium: r.medium,
    }));

    // ---- notes ----
    const notes: { label: string; text: string }[] = [];
    const add = (label: string, raw: string | null | undefined) => {
      const t = withoutAccess(oneLine(raw ?? ""), isAccessNote);
      if (t.length < 3) return;
      const shown = moneyNote(t);
      if (shown.trim()) notes.push({ label, text: clip(shown, 600) });
    };
    const [{ aryeoCustomerNote }, { askMedium }] = await Promise.all([import("@/lib/shoot"), import("@/lib/comms")]);
    const order = orderAskCandidates(
      { id: p.id, clientId: p.clientId, clientName: p.client?.name ?? null, createdAt: p.createdAt, appointments: p.appointments, orderItems: p.orderItems, deliverables: p.deliverables },
      { customerNote: aryeoCustomerNote, isAccessNote, askMedium },
    );
    for (const c of order) {
      const isAddon = (c.dedupeKey ?? "").startsWith("addon:");
      if (!isAddon) add("On the order", c.text);
      else if (mediumMatches(c.medium ?? null, medium)) add("Add-on ordered", `${c.text.replace(/^Ordered:\s*/i, "")}: check it is on the finished work and correct.`);
    }
    add("From the office", p.notes);
    add("Photographer's notes", p.editorBrief);
    if (medium === "video") add("Video notes", p.videoInstructions);
    else add("Remove", p.removalNotes);

    // ---- the last "Checked" for this medium ----
    const mine = lastChecked.filter((r) => mediumMatches(r.medium, medium) && r.confirmedAt);
    const checked = mine.length
      ? (() => {
          const top = mine[0];
          // The one press: the confirmations stamped within a minute of the newest by the same person.
          const same = mine.filter((r) => r.confirmedBy === top.confirmedBy && Math.abs(r.confirmedAt!.getTime() - top.confirmedAt!.getTime()) < 60_000);
          return { by: top.confirmedBy ?? "someone", atISO: top.confirmedAt!.toISOString(), count: same.length };
        })()
      : null;

    return { projectId, flags, requests: reqs, notes, openRequests: reqs.length, checked };
  } catch (e) {
    console.error("[job-checks] read failed", projectId, e);
    return empty(projectId);
  }
}
