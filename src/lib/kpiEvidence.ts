import "server-only";
import { prisma } from "@/lib/prisma";
import { etAt, etDayBoundsUtc, etDayKey, etDateTime } from "@/lib/datetime";
import { categoryHandoffAt, liveHandoffCategories, type HandoffCategory } from "@/lib/handoff";
import { photoTargetFor, rawOverageCeiling } from "@/lib/culling";
import { ownsShootWhere } from "@/lib/shoot";
import { liveAppointment } from "@/lib/shootDayText";
import { isSyntheticClientRow } from "@/lib/testClients";
import { hasConfirmedIssueCause } from "@/lib/issueCauses";
import { readDeadlineOverrides, readInstructionsAsks, type KpiDeadlineOverride } from "@/lib/kpiStore";
import type { KpiEntryBase, ShootFact } from "@/lib/kpi";

// ---------------------------------------------------------------------------
// KPI EVIDENCE: THE HUB'S OWN RECORDS, AS ENTRIES (Oct 22 2026).
//
// Every automatic entry on a scorecard is worked out here, on every read,
// from records the hub already keeps. Nothing is stored about them except
// what a person later said (a dispute, a resolution: lib/kpiStore), so an
// entry can never disagree with the job it is about.
//
// LATE UPLOADS (Jordan, Oct 22 2026: "mark late uploads ... in the KPI
// sections"). The deadlines are the terms':
//   · photos and photo notes: midnight at the end of the shoot day (ET);
//   · video files and video notes: 9:00 AM ET the next morning;
//   · a deadline agreed for one shoot (kpi_deadline:<projectId>) wins.
// The shoot day is the job's last live visit (its shoot date when it has
// none), the same moment the missing-instructions nudge reads. A half is ON
// TIME when its upload-page submit (the half's own handoff stamp, else the
// whole wrap-up stamp) landed by the deadline: that submit is what carries the
// notes and says the files are in. A half still not submitted once its
// deadline has passed is late too. What Dropbox showed (the raws-in stamps and
// the last file count) and the photographer's own "uploaded" ticks are shown
// on the entry as evidence; they never make a half late or on time by
// themselves, because the sweep that records them runs on its own clock.
// A half the job no longer owes (couldn't complete, waived, off the order)
// is never late. Only the person whose upload page it is (the job's
// photographer) is charged, never a second shooter.
//
// INCOMPLETE OR THIN VIDEO INSTRUCTIONS (same day): Reliability and
// communication, "required notes / proper handoff". Judged once the video
// half has been handed in, on a job that owes instructions at all (a plain
// social reel owes none, lib/handoff minimalReel):
//   · INCOMPLETE: the handoff engine's own gaps that are the photographer's
//     (handoffReadinessOf: the flow and vision, the premium script, the
//     agent's intro script, the video count) are still open;
//   · THIN: fewer than THIN_WORDS words of their own in the video
//     instructions (section headings, the STYLE and COLOR PROFILE lines and
//     placeholder answers like "n/a" or "standard" do not count), with no
//     instructions file in Dropbox.
// One entry per shoot either way. A video half that was not in by its
// deadline is a late upload instead (the morning-after ask for the missing
// instructions is shown on that entry), never both for the same miss. A
// revision a reviewer traced to a missing or conflicting brief is shown as
// ADVISORY: the brief can be the office's too, so it counts only when the
// owner says it does.
//
// QUALITY: fix notes and photo flags from review, revisions a reviewer traced
// to the capture (RevisionIssue cause CAPTURE, confirmed by a person), and
// shoots over the raw budget. An ordinary client revision is listed, as "not
// counted", and never scores: it is not a production failure.
//
// MISSED COVERAGE (Jordan, Oct 22 2026: "one thing that should be tracked is
// missing photos, and we can find that out from texts or emails from
// clients"). The comms pipeline already files every client photo request from
// a text, email or call as a ClientAsk on the job (lib/clientAsks,
// photoDelivery/clientAsked). Each one on a shoot this person shot is read
// with a plain rule (coverageVerdict):
//   · MISS: the client says a shot was missed or never taken ("you missed the
//     basement", "no photos of the backyard") and does not ask for something
//     new: Quality and QC, counts, disputable;
//   · EXTRA: the client wants an extra or different shot ("can you add one
//     more of the kitchen", "a different angle of the pool") and says nothing
//     was missed: listed, never counts;
//   · NEEDS REVIEW: anything in between ("the basement photos are missing"
//     can be a shoot miss or an editing or delivery slip): shown, counts only
//     when Jordan confirms it was a miss on the shoot.
// A request marked Not needed, and anything not about coverage (a sky swap, a
// car removed), is left out.
//
// CLIENT EXPERIENCE: client ratings (the photographer question first), a
// complaint about the shoot itself counted as a 2 of 5, a compliment as a 5.
// Anything the hub classified as editing, turnaround or delivery is left out.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
/** The video half is due at this ET hour the morning after the shoot day (the terms). */
export const VIDEO_DUE_HOUR = 9;
/** Fewer of the photographer's own words than this in the video instructions reads as thin. */
export const THIN_WORDS = 12;

const HEADINGS = new Set([
  "VISION FOR THE EDIT", "SUMMARY", "SHOTS THAT MUST BE SHOWN", "AREAS TO AVOID", "THINGS TO AVOID",
  "REALTOR REQUESTS", "ADDITIONAL NOTES", "INTRO SCRIPT", "EDITING NOTES",
  "SCRIPT FOR THIS VIDEO", "SONG OR MUSIC",
]);
const PLACEHOLDER = /^(n\/?a|na|none|nothing|no|nope|same|same as usual|as usual|standard|normal|usual|ok|okay|good|fine|tbd|see above|-+|\.+)$/i;

/** How many of the photographer's OWN words a video brief holds (pure). */
export function ownWords(text: string | null | undefined): number {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => t && !/^STYLE:/i.test(t) && !/^COLOR PROFILE:/i.test(t) && !HEADINGS.has(t.toUpperCase()) && !PLACEHOLDER.test(t))
    .join(" ")
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
}

const COVER_NOUN = /\b(photos?|pictures?|pics?|shots?|images?|angles?|views?|rooms?|bed ?rooms?|bath ?rooms?|kitchen|basement|garage|back ?yard|yard|patio|deck|pool|exterior|front|drone|aerials?|twilight|closet|office|dining|living|laundry|porch|attic|loft|den|foyer|staircase|stairs)\b/i;
const MISS_STRONG = /\b(missed|forgot|forgotten|never (got|took|shot|captured)|did ?n[o']?t (get|take|shoot|capture|photograph)|was ?n[o']?t (photographed|shot|captured)|were ?n[o']?t (photographed|shot|captured)|not (photographed|captured)|no (photos?|pictures?|pics|shots?|images?) of)\b/i;
const MISS_WEAK = /\b(missing|where (is|are) the|do ?n[o']?t see|can'?t find|cannot find|there'?s no|there (is|are) no|left out|not included|is ?n[o']?t (in|there|included)|are ?n[o']?t (in|there|included))\b/i;
const EXTRA = /\b(another|additional|extra|more (photos?|pictures?|pics|shots?|angles?)|different (angle|shot|photo|picture|view)|re-?take|re-?shoot|redo|also (get|take|add|shoot)|can (you|we) (also )?add|add (a|an|one|some)|instead|would (like|love) (a|an|some)|could (you|we) (also )?(get|take))\b/i;

/**
 * Is a client's photo request about a missed shot (pure)? "miss" counts,
 * "extra" never does, "unsure" waits for Jordan, null = not about coverage.
 */
export function coverageVerdict(text: string | null | undefined): "miss" | "extra" | "unsure" | null {
  const t = (text ?? "").replace(/[’‘]/g, "'");
  const strong = MISS_STRONG.test(t);
  const weak = MISS_WEAK.test(t);
  const extra = EXTRA.test(t);
  if (!strong && !weak && !extra) return null;
  if (!strong && !COVER_NOUN.test(t)) return null;
  if (strong && !extra) return "miss";
  if (extra && !strong && !weak) return "extra";
  return "unsure";
}

function nextDayKey(key: string): string {
  return etDayKey(new Date(Date.parse(`${key}T12:00:00Z`) + DAY));
}

/** The terms' deadlines for a shoot day (pure). */
export function uploadDeadlines(shootDay: string): Record<HandoffCategory, Date> {
  return { photos: etDayBoundsUtc(shootDay).end, video: etAt(nextDayKey(shootDay), VIDEO_DUE_HOUR) };
}

/** "1 h 14 min", "2 days 3 h" */
export function howLong(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} day${d === 1 ? "" : "s"} ${h % 24} h` : `${d} day${d === 1 ? "" : "s"}`;
}

const clip = (s: string | null | undefined, n = 140) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const streetOf = (title: string, addressLine: string | null) =>
  (addressLine?.trim() && !/^\[No address/i.test(addressLine) ? addressLine.trim() : title.split(",")[0].trim()) || "a shoot";

const SELECT = {
  id: true, title: true, addressLine: true, shootDate: true, createdAt: true, photographerId: true,
  client: { select: { id: true, name: true } },
  photographer: { select: { name: true } },
  appointments: { select: { status: true, startAt: true, assignedToId: true } },
  deliverables: {
    select: {
      type: true, label: true, productTitle: true, videoStyle: true, uploadedAt: true,
      notCompletedReason: true, waivedAt: true, removedFromOrderAt: true,
    },
  },
  orderItems: { where: { isCanceled: false }, select: { title: true } },
  packageName: true,
  debriefSubmittedAt: true, photosHandoffAt: true, videoHandoffAt: true, photosHandoffBy: true, videoHandoffBy: true,
  uploadedAt: true, statusEvidence: true,
  videoInstructions: true, editorBrief: true, instructionsDropboxPath: true,
  reelScript: true, reelHook: true, scriptConfirmedAt: true, videosFilmed: true,
  rawPhotoCount: true, photoTarget: true, squareFeet: true,
  revisionRequestedAt: true,
} as const;

type Row = Awaited<ReturnType<typeof loadRows>>[number];
function loadRows(memberId: string, from: Date, to: Date) {
  return prisma.project.findMany({
    where: {
      AND: [
        ownsShootWhere(memberId),
        { status: { not: "CANCELLED" } },
        { OR: [{ shootDate: { gte: from, lte: to } }, { appointments: { some: { startAt: { gte: from, lte: to } } } }] },
      ],
    },
    select: SELECT,
  });
}

function dropboxCounts(statusEvidence: string | null): { rawPhotos: number | null; rawVideo: number | null; stale: boolean } | null {
  if (!statusEvidence) return null;
  try {
    const d = (JSON.parse(statusEvidence) as { dropbox?: { rawPhotos?: number; rawVideo?: number; stale?: boolean } }).dropbox;
    return d ? { rawPhotos: d.rawPhotos ?? null, rawVideo: d.rawVideo ?? null, stale: !!d.stale } : null;
  } catch {
    return null;
  }
}

/** When the shoot finished, for the deadlines: the last live visit; null while one is still to come. */
function finishedAt(r: Row, now: Date): Date | null {
  if (r.appointments.length === 0) return r.shootDate && r.shootDate.getTime() <= now.getTime() ? r.shootDate : null;
  const visits = r.appointments.filter(liveAppointment);
  if (visits.length === 0) return null;
  if (visits.some((a) => a.startAt!.getTime() > now.getTime())) return null;
  return new Date(Math.max(...visits.map((a) => a.startAt!.getTime())));
}

export type Evidence = { shoots: ShootFact[]; entries: KpiEntryBase[]; coachingNotes: number };

/**
 * Everything the scorecard needs about one person over [startKey, endKey]
 * (ET days), counting only work that happened by `windowEnd`. Reads only.
 */
export async function loadEvidence(
  memberId: string,
  w: { startKey: string; endKey: string; start: Date; windowEnd: Date },
  now: Date,
): Promise<Evidence> {
  const rows = (await loadRows(memberId, new Date(w.start.getTime() - 3 * DAY), w.windowEnd)).filter((r) => !isSyntheticClientRow(r.client));
  const overrides = await readDeadlineOverrides(rows.map((r) => r.id));

  const shoots: ShootFact[] = [];
  const entries: KpiEntryBase[] = [];
  const dayOf = new Map<string, string>();
  const streetById = new Map<string, string>();
  const lateVideo: { entry: KpiEntryBase; row: Row; due: Date }[] = [];
  const { handoffReadinessOf } = await import("@/lib/tasks");

  for (const r of rows) {
    const shotAt = finishedAt(r, now);
    if (!shotAt || shotAt.getTime() > w.windowEnd.getTime()) continue;
    const day = etDayKey(shotAt);
    if (day < w.startKey || day > w.endKey) continue;
    const street = streetOf(r.title, r.addressLine);
    dayOf.set(r.id, day);
    streetById.set(r.id, street);
    // The upload page is the job photographer's (the person the handoff engine
    // names); a second shooter is never charged for it.
    const owner = r.photographerId === memberId || (r.photographerId == null && r.appointments.some((a) => liveAppointment(a) && a.assignedToId === memberId));
    const halves = liveHandoffCategories(r.deliverables);
    const terms = uploadDeadlines(day);
    const ov: KpiDeadlineOverride | undefined = overrides.get(r.id);
    const dbx = dropboxCounts(r.statusEvidence);
    let judged = 0;
    let videoHandoff = false;

    for (const half of halves) {
      const agreed = half === "photos" ? ov?.photos : ov?.video;
      const due = agreed && Number.isFinite(Date.parse(agreed)) ? new Date(agreed) : terms[half];
      const handedIn = categoryHandoffAt(r, half);
      const passed = now.getTime() > due.getTime();
      if (!handedIn && !passed) continue;
      judged++;
      const late = handedIn ? handedIn.getTime() > due.getTime() : true;
      if (!late || !owner) continue;
      const ticks = r.deliverables
        .filter((d) => (half === "photos" ? ["PHOTOS", "DRONE", "TWILIGHT"] : ["VIDEO", "SOCIAL_REEL"]).includes(d.type) && !d.notCompletedReason && !d.waivedAt && !d.removedFromOrderAt)
        .map((d) => d.uploadedAt)
        .filter((x): x is Date => !!x);
      const tick = ticks.length ? new Date(Math.max(...ticks.map((t) => t.getTime()))) : null;
      const what = half === "photos" ? "photos and photo notes" : "video files and video notes";
      const by = half === "photos" ? r.photosHandoffBy : r.videoHandoffBy;
      const detail = [
        `Shoot day: ${etDateTime(shotAt)}.`,
        agreed
          ? `Due ${etDateTime(due)}: a deadline agreed for this shoot${ov?.note ? ` (${ov.note})` : ""}.`
          : `Due ${etDateTime(due)}: ${what} are due ${half === "photos" ? "by midnight on the shoot day" : "by 9:00 AM the next morning"}.`,
        handedIn
          ? `Submitted on the upload page ${etDateTime(handedIn)}${by ? ` by ${by}` : ""}, ${howLong(handedIn.getTime() - due.getTime())} after the deadline.`
          : `Not submitted on the upload page yet: ${howLong(now.getTime() - due.getTime())} past the deadline.`,
        ...(tick ? [`Marked uploaded on the upload page ${etDateTime(tick)}.`] : []),
        ...(half === "photos" && r.uploadedAt ? [`Raws first recorded by the hub ${etDateTime(r.uploadedAt)}.`] : []),
        ...(dbx && typeof (half === "photos" ? dbx.rawPhotos : dbx.rawVideo) === "number"
          ? [`Last Dropbox check: ${half === "photos" ? dbx.rawPhotos : dbx.rawVideo} raw ${half === "photos" ? "photo" : "video"} file${(half === "photos" ? dbx.rawPhotos : dbx.rawVideo) === 1 ? "" : "s"}${dbx.stale ? " (an older count)" : ""}.`]
          : []),
      ];
      const entry: KpiEntryBase = {
        id: `late-${half}:${r.id}`,
        kind: half === "photos" ? "late_photos" : "late_video",
        area: "reliability",
        day,
        at: (handedIn ?? due).toISOString(),
        title: `${handedIn ? (half === "photos" ? "Photos late" : "Video late") : half === "photos" ? "Photos not in yet" : "Video not in yet"}: ${street}`,
        detail,
        projectId: r.id,
        effect: "against",
        auto: true,
        advisory: false,
      };
      entries.push(entry);
      if (half === "video") lateVideo.push({ entry, row: r, due });
    }

    // Video instructions, once the video half is in.
    if (owner && halves.includes("video")) {
      const readiness = await handoffReadinessOf({
        ...r,
        deliverables: r.deliverables.filter((d) => !d.removedFromOrderAt && !d.waivedAt),
        photographer: r.photographer,
      }).catch(() => null);
      const handedIn = categoryHandoffAt(r, "video");
      if (readiness && !readiness.minimalReel && handedIn) {
        videoHandoff = true;
        // TWO VIDEOS, TWO SETS OF INSTRUCTIONS (Oct 22 2026): a later video of
        // a multi-video job with no words of its own is incomplete (the
        // readiness above already names it), and a premium one with too few
        // is thin. A video the hub only set up AFTER this handoff is the hub's
        // miss, not the photographer's, and is not held against them.
        const liveVideoRows = r.deliverables.filter((d) => !d.removedFromOrderAt && !d.waivedAt && (d.type === "VIDEO" || d.type === "SOCIAL_REEL"));
        const { laterVideoGap, perVideoRuleApplies } = await import("@/lib/perVideoInstructions");
        const later = liveVideoRows.length > 1 && perVideoRuleApplies(handedIn)
          ? (await import("@/lib/deliverableOutputs").then((m) => m.videoInstructionsFor(r.id)).catch(() => [])).filter((v) => v.number > 1)
          : [];
        const excused = new Set(later.filter((v) => v.createdAt && v.createdAt.getTime() > handedIn.getTime()).map((v) => laterVideoGap(v, { instructionsInDropbox: !!r.instructionsDropboxPath }) ?? ""));
        const gaps = readiness.gaps.filter((g) => g.owedBy === "photographer" && g.key !== "debrief" && !excused.has(g.label));
        const words = ownWords(r.videoInstructions ?? r.editorBrief);
        const thinLater = r.instructionsDropboxPath ? [] : later
          .filter((v) => v.shape === "full" && v.own && !(v.createdAt && v.createdAt.getTime() > handedIn.getTime()) && ownWords(v.own) < THIN_WORDS)
          .map((v) => `${ownWords(v.own)} word${ownWords(v.own) === 1 ? "" : "s"} of your own for video ${v.number} (${v.label}); the rule is at least ${THIN_WORDS}.`);
        const thin = !r.instructionsDropboxPath && words < THIN_WORDS;
        if (gaps.length || thin || thinLater.length) {
          entries.push({
            id: `instructions:${r.id}`,
            kind: "instructions",
            area: "reliability",
            day,
            at: handedIn.toISOString(),
            title: `${gaps.length ? "Video instructions incomplete" : "Video instructions thin"}: ${street}`,
            detail: [
              `Video half submitted ${etDateTime(handedIn)}.`,
              ...(gaps.length ? [`Still missing: ${gaps.map((g) => g.label).join("; ")}.`] : []),
              ...(thin ? [`${words} word${words === 1 ? "" : "s"} of your own in the video instructions; the rule is at least ${THIN_WORDS} (headings, the style and color lines and answers like "n/a" or "standard" do not count) or an instructions file in Dropbox.`] : []),
              ...thinLater,
            ],
            projectId: r.id,
            effect: "against",
            auto: true,
            advisory: false,
          });
        }
      }
      const pending = lateVideo.find((x) => x.row.id === r.id);
      if (pending && readiness && !handedIn) {
        const gaps = readiness.gaps.filter((g) => g.owedBy === "photographer" && g.key !== "debrief");
        if (gaps.length) pending.entry.detail.push(`Still missing now: ${gaps.map((g) => g.label).join("; ")}.`);
      }
    }

    // Raw budget (culling).
    const counted = r.rawPhotoCount != null && r.rawPhotoCount > 0;
    let overBudget = false;
    if (counted) {
      const target = photoTargetFor(r);
      const ceiling = rawOverageCeiling(target);
      overBudget = (r.rawPhotoCount ?? 0) > ceiling;
      if (overBudget) {
        entries.push({
          id: `over-budget:${r.id}`,
          kind: "over_budget",
          area: "quality",
          day,
          at: shotAt.toISOString(),
          title: `Over the raw budget: ${street}`,
          detail: [
            `${r.rawPhotoCount} raw photos against a ceiling of ${ceiling} (a ${target}-photo home).`,
            ...(r.squareFeet == null && r.photoTarget == null ? ["No square footage on file, so the standard tier was used: a big house can read as over. Jordan can set the target on the job."] : []),
          ],
          projectId: r.id,
          effect: "against",
          auto: true,
          advisory: false,
        });
      }
    }

    shoots.push({
      projectId: r.id,
      street,
      day,
      owner,
      halvesJudged: owner ? judged : 0,
      videoHandoff,
      cullCounted: counted,
      noSqft: counted && r.squareFeet == null && r.photoTarget == null,
      reviewed: false,
    });
  }

  // Evidence on the late video entries: Dropbox's raw-video stamp and the
  // morning-after asks for the missing instructions.
  if (lateVideo.length) {
    const ids = lateVideo.map((x) => x.row.id);
    const [outs, asks] = await Promise.all([
      prisma.deliverableOutput.findMany({ where: { projectId: { in: ids }, category: "VIDEO", rawInAt: { not: null } }, select: { projectId: true, rawInAt: true } }),
      readInstructionsAsks(ids),
    ]);
    for (const { entry, row, due } of lateVideo) {
      const raw = outs.filter((o) => o.projectId === row.id).map((o) => o.rawInAt!).sort((a, b) => a.getTime() - b.getTime())[0];
      if (raw) {
        entry.detail.push(`Raw video first confirmed in Dropbox ${etDateTime(raw)}.`);
        if (raw.getTime() <= due.getTime() && categoryHandoffAt(row, "video")) {
          entry.title = `Video notes late (files were in on time): ${streetById.get(row.id)}`;
        }
      }
      for (const a of asks.filter((x) => x.projectId === row.id)) {
        entry.detail.push(`The hub asked for the missing instructions ${a.at ? etDateTime(new Date(a.at)) : a.day}${a.missing.length ? `: ${a.missing.join("; ")}` : ""}.`);
      }
    }
  }

  const ids = shoots.map((s) => s.projectId);
  if (ids.length === 0) return { shoots, entries: [...entries, ...(await feedbackEntries(memberId, w, streetById))], coachingNotes: 0 };

  const [notes, reviewedRows, flags, issues, briefs] = await Promise.all([
    prisma.mediaNote.findMany({
      where: { lane: "PHOTOGRAPHER", parentId: null, projectId: { in: ids }, OR: [{ photographerId: null }, { photographerId: memberId }] },
      select: { id: true, projectId: true, kind: true, body: true, status: true, authorName: true, createdAt: true },
    }),
    prisma.mediaNote.findMany({ where: { parentId: null, projectId: { in: ids } }, select: { projectId: true }, distinct: ["projectId"] }),
    prisma.imageFlag.findMany({ where: { projectId: { in: ids } }, select: { id: true, projectId: true, tags: true, note: true, caption: true, status: true, createdAt: true } }),
    prisma.revisionIssue.findMany({
      where: { projectId: { in: ids }, state: { notIn: ["NOT_APPLICABLE", "DUPLICATE"] } },
      select: { id: true, projectId: true, cause: true, causeConfirmedAt: true, causeConfirmedBy: true, originalText: true, summary: true, createdAt: true },
    }),
    prisma.revisionBrief.findMany({ where: { projectId: { in: ids }, NOT: { source: "office" } }, select: { projectId: true, createdAt: true } }),
  ]);
  const reviewed = new Set(reviewedRows.map((x) => x.projectId));
  for (const s of shoots) s.reviewed = reviewed.has(s.projectId);
  const ownerOf = new Map(shoots.map((s) => [s.projectId, s.owner]));

  // Missed coverage: the client's own photo requests (text, email, call) on a shoot they shot.
  const asks = await prisma.clientAsk.findMany({
    where: {
      projectId: { in: shoots.filter((s) => s.owner).map((s) => s.projectId) },
      kind: "SPECIAL_REQUEST",
      source: { in: ["text", "email", "call"] },
      state: { not: "NOT_NEEDED" },
      OR: [{ medium: { in: ["photo", "both", "unclear"] } }, { medium: null }],
    },
    select: { id: true, projectId: true, text: true, summary: true, source: true, askedBy: true, askedAt: true, state: true },
  });
  for (const a of asks) {
    const verdict = coverageVerdict(a.text);
    if (!verdict || !a.projectId) continue;
    const street = streetById.get(a.projectId);
    const said = [`"${clip(a.text, 400)}"`, `${a.askedBy ? `${a.askedBy}, by` : "The client, by"} ${a.source === "call" ? "phone" : a.source}, ${etDateTime(a.askedAt)}.`];
    entries.push({
      id: `coverage:${a.id}`,
      kind: verdict === "extra" ? "extra_request" : "missed_coverage",
      area: "quality",
      day: dayOf.get(a.projectId)!,
      at: a.askedAt.toISOString(),
      title:
        verdict === "miss" ? `Client says a shot was missed: ${street}`
        : verdict === "extra" ? `Client asked for an extra or different shot: ${street}`
        : `Client may be missing a photo (needs review): ${street}`,
      detail: [
        ...said,
        verdict === "miss"
          ? "Counts as missed coverage. If the photo was taken and lost in editing or delivery, dispute it: that is not a miss on the shoot."
          : verdict === "extra"
            ? "A request for more or different shots is not a miss and never counts."
            : "Needs review: it counts only if Jordan confirms the shot was missed on the shoot (an editing or delivery slip is not your miss).",
      ],
      projectId: a.projectId,
      effect: verdict === "extra" ? "neutral" : "against",
      auto: true,
      advisory: verdict === "unsure",
    });
  }

  let coachingNotes = 0;
  for (const n of notes) {
    if (n.kind === "coaching") { coachingNotes++; continue; }
    if (n.kind !== "fix") continue;
    entries.push({
      id: `fix-note:${n.id}`,
      kind: "qc_fix",
      area: "quality",
      day: dayOf.get(n.projectId)!,
      at: n.createdAt.toISOString(),
      title: `Fix note on ${streetById.get(n.projectId)}: ${clip(n.body, 90)}`,
      detail: [`"${clip(n.body, 400)}"`, `From ${n.authorName ?? "review"}, ${etDateTime(n.createdAt)}${n.status !== "OPEN" ? `; marked ${n.status.toLowerCase()}` : ""}.`],
      projectId: n.projectId,
      effect: "against",
      auto: true,
      advisory: false,
    });
  }
  for (const f of flags) {
    let tags: string[] = [];
    try { tags = (JSON.parse(f.tags) as unknown[]).filter((t): t is string => typeof t === "string"); } catch { /* none */ }
    entries.push({
      id: `photo-flag:${f.id}`,
      kind: "qc_flag",
      area: "quality",
      day: dayOf.get(f.projectId)!,
      at: f.createdAt.toISOString(),
      title: `Photo flagged on ${streetById.get(f.projectId)}${tags.length ? `: ${tags.join(", ")}` : ""}`,
      detail: [
        ...(f.note || f.caption ? [`"${clip(f.note || f.caption, 300)}"`] : []),
        `Flagged ${etDateTime(f.createdAt)}${f.status === "FIXED" ? "; since fixed" : ""}.`,
      ],
      projectId: f.projectId,
      effect: "against",
      auto: true,
      advisory: false,
    });
  }

  const clientAsked = new Map<string, Date>();
  for (const b of briefs) if (!clientAsked.has(b.projectId)) clientAsked.set(b.projectId, b.createdAt);
  for (const i of issues) {
    const confirmed = hasConfirmedIssueCause(i);
    const words = clip(i.summary || i.originalText, 300);
    if (confirmed && i.cause === "CAPTURE") {
      entries.push({
        id: `capture-revision:${i.id}`,
        kind: "capture_revision",
        area: "quality",
        day: dayOf.get(i.projectId)!,
        at: (i.causeConfirmedAt ?? i.createdAt).toISOString(),
        title: `Revision traced to the capture: ${streetById.get(i.projectId)}`,
        detail: [`"${words}"`, `${i.causeConfirmedBy} classified it as a capture problem, ${etDateTime(i.causeConfirmedAt)}.`],
        projectId: i.projectId,
        effect: "against",
        auto: true,
        advisory: false,
      });
    } else if (confirmed && i.cause === "BRIEF_GAP" && ownerOf.get(i.projectId)) {
      entries.push({
        id: `brief-gap:${i.id}`,
        kind: "brief_gap",
        area: "reliability",
        day: dayOf.get(i.projectId)!,
        at: (i.causeConfirmedAt ?? i.createdAt).toISOString(),
        title: `Revision traced to the brief: ${streetById.get(i.projectId)}`,
        detail: [
          `"${words}"`,
          `${i.causeConfirmedBy} classified it as a missing or conflicting brief, ${etDateTime(i.causeConfirmedAt)}.`,
          "Advisory: the brief can be the office's too, so this counts only if Jordan says it does.",
        ],
        projectId: i.projectId,
        effect: "against",
        auto: true,
        advisory: true,
      });
    } else if (!clientAsked.has(i.projectId)) {
      clientAsked.set(i.projectId, i.createdAt);
    }
  }
  for (const s of shoots) {
    const row = rows.find((r) => r.id === s.projectId);
    if (row?.revisionRequestedAt && !clientAsked.has(s.projectId)) clientAsked.set(s.projectId, row.revisionRequestedAt);
  }
  // An ordinary client revision is listed so it is visible, and never scores.
  for (const [projectId, at] of clientAsked) {
    entries.push({
      id: `client-revision:${projectId}`,
      kind: "client_revision",
      area: "quality",
      day: dayOf.get(projectId)!,
      at: at.toISOString(),
      title: `Client asked for changes: ${streetById.get(projectId)}`,
      detail: ["An ordinary client creative revision is not a production failure and never counts. Only a revision a reviewer traces to the capture does."],
      projectId,
      effect: "neutral",
      auto: true,
      advisory: false,
    });
  }

  entries.push(...(await feedbackEntries(memberId, w, streetById)));
  return { shoots, entries, coachingNotes };
}

/** Client ratings, complaints and compliments (Feedback), by when the client said it. */
async function feedbackEntries(
  memberId: string,
  w: { start: Date; windowEnd: Date },
  streetById: Map<string, string>,
): Promise<KpiEntryBase[]> {
  const rows = await prisma.feedback.findMany({
    where: {
      createdAt: { gte: w.start, lte: w.windowEnd },
      dismissedAt: null,
      // Stamped to them, or on a job they shot and not stamped to somebody else.
      AND: [
        { OR: [{ photographerId: memberId }, { project: ownsShootWhere(memberId) }] },
        { OR: [{ photographerId: memberId }, { photographerId: null }] },
      ],
    },
    select: {
      id: true, projectId: true, rating: true, photographerRating: true, sentiment: true, attribution: true, attributionWhy: true,
      body: true, source: true, createdAt: true, project: { select: { title: true, addressLine: true } },
    },
  });
  const out: KpiEntryBase[] = [];
  for (const f of rows) {
    const street = streetById.get(f.projectId) ?? streetOf(f.project.title, f.project.addressLine);
    const base = {
      area: "client" as const,
      day: etDayKey(f.createdAt),
      at: f.createdAt.toISOString(),
      projectId: f.projectId,
      auto: true,
      advisory: false,
    };
    const said = [`"${clip(f.body, 400)}"`, `From the client by ${f.source === "form" ? "the feedback form" : f.source}, ${etDateTime(f.createdAt)}.`];
    if (f.attribution === "OPERATIONS" && f.photographerRating == null) {
      out.push({ ...base, id: `feedback:${f.id}`, kind: "ops_feedback", title: `Feedback about editing or delivery: ${street}`, detail: [...said, `Not counted: it is about the edit, turnaround or delivery${f.attributionWhy ? ` (${f.attributionWhy})` : ""}, which is not your work.`], effect: "neutral" });
      continue;
    }
    // On a MIXED row only the photographer's own rating counts.
    const value = f.attribution === "MIXED" ? f.photographerRating : f.photographerRating ?? f.rating;
    if (value != null) {
      out.push({
        ...base, id: `feedback:${f.id}`, kind: "client_rating", value,
        title: `Client rated ${value} of 5: ${street}`,
        detail: [...said, ...(f.photographerRating == null ? ["No answer to the photographer question, so the overall rating is used."] : [])],
        effect: value >= 4 ? "for" : value <= 2 ? "against" : "neutral",
      });
    } else if (f.sentiment === "NEGATIVE" && f.attribution === "ONSITE") {
      out.push({ ...base, id: `feedback:${f.id}`, kind: "complaint", value: 2, title: `Client complaint: ${street}`, detail: [...said, "A complaint about the shoot with no rating counts as a 2 of 5."], effect: "against" });
    } else if (f.sentiment === "POSITIVE") {
      out.push({ ...base, id: `feedback:${f.id}`, kind: "compliment", value: 5, title: `Client compliment: ${street}`, detail: [...said, "A compliment with no rating counts as a 5 of 5."], effect: "for" });
    }
  }
  return out;
}
