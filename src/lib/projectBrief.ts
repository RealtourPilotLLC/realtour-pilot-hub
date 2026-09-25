import "server-only";

import { prisma } from "@/lib/prisma";
import { outputsForProject, filmingBriefFor, type OutputRowView, type FilmingBrief } from "@/lib/deliverableOutputs";
import { handoffReadiness, meaningfulBrief } from "@/lib/handoff";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { parseEvidence, evidenceTone, type EvidenceTone } from "@/lib/statusEvidence";
import { outstandingPromise } from "@/lib/deliveryBoard";
import { turnaroundRules } from "@/lib/settings";

// ---------------------------------------------------------------------------
// ONE SUMMARY OF A JOB (R08, review Sep 18).
//
// "One concise project summary covering scope, logical outputs, current
// versions, promises, the latest client request, blocker, owner, and next
// action." Everything on that list already existed on the project page, spread
// over nine cards in workflow order — which is the right order for DOING the
// job and the wrong one for ANSWERING A QUESTION ABOUT IT. A person asked
// "where is 893 S Matlack" had to read the status card, count the deliverables,
// open the outputs, find the revision note and infer the rest.
//
// Nothing here is new information. It is the same facts from the same engines,
// said once, at the top, in the order somebody asks for them. Where two engines
// could disagree the summary uses the one that already arbitrates — the tone
// for what is owed, handoffReadiness for what is blocking, the output rows for
// versions — so this card cannot become a tenth opinion.
// ---------------------------------------------------------------------------

export type BriefOwner = { who: string; whose: "editor" | "office" | "field" | "client" | "nobody" };

export type ProjectBrief = {
  projectId: string;
  /** what was sold, in words */
  scope: string[];
  /** the per-video rows, in order */
  outputs: OutputRowView[];
  /** how many of them are finished and how many are owed */
  outputsDone: number;
  outputsOwed: number;
  /** the current version of the video furthest along, for the one-line answer */
  currentVersion: string | null;
  /** the promise the client was given, and where it came from */
  promisedAt: Date | null;
  promiseSource: "frozen" | "office" | "computed" | null;
  targetAt: Date | null;
  overdue: boolean;
  /** the newest thing the client asked for, with its date */
  latestRequest: { at: Date; text: string; source: string } | null;
  /** the one thing in the way, or null */
  blocker: string | null;
  owner: BriefOwner;
  nextAction: string;
  /** the status engine's own verdict, so the summary cannot contradict it */
  tone: EvidenceTone;
  /**
   * CP-09: on a content session, which topic each owed video is, with the
   * photographer's note, the script and the raw folder — the same rows the
   * printed brief and /edit read (deliverableOutputs.filmingBriefFor). Null on
   * a listing shoot.
   */
  filming: FilmingBrief | null;
};

const clip = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export async function projectBrief(projectId: string): Promise<ProjectBrief | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, status: true, shootDate: true, packageName: true,
      statusEvidence: true, statusCheckedAt: true,
      evidenceAttemptedAt: true, evidenceSucceededAt: true, evidenceError: true,
      promisedDueAt: true, promisedTargetAt: true, promisedTierKey: true, promisedReason: true,
      // deliveryDue (the JOB-level date the Aryeo sync writes off the video
      // SLA) is deliberately no longer read here — see THE PROMISE below.
      dueOverrideAt: true, videosOwedOverride: true, videosFilmed: true,
      revisionNote: true, revisionRequestedAt: true,
      debriefSubmittedAt: true, videoInstructions: true, editorBrief: true,
      reelScript: true, reelHook: true, scriptConfirmedAt: true,
      editor: { select: { name: true } }, editorVendorKey: true,
      photographer: { select: { name: true } },
      // ONE PROMISE (F05, review Sep 20 2026) — the extra columns below are
      // exactly deliveryBoard's PromiseInput, so this card can ask the promise
      // engine the same question Kyle's board asks instead of keeping its own
      // answer. deliveredAt and tierOverride are new here; the rest were
      // already loaded.
      deliveredAt: true, tierOverride: true,
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      appointments: { select: { startAt: true, status: true }, orderBy: { startAt: "asc" } },
      deliverables: {
        where: { removedFromOrderAt: null },
        // status/uploadedAt are the promise engine's witnesses for what has
        // actually landed. The WHERE stays as it was — a waived line still
        // proves the job SOLD video (owesVideo below), and the promise engine
        // gets the same waivedAt-free list the board gives it, filtered in
        // memory a few lines down.
        select: { type: true, label: true, productTitle: true, quantity: true, waivedAt: true, status: true, uploadedAt: true },
      },
      revisionBriefs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true, headline: true, originalText: true, source: true },
      },
    },
  });
  if (!p) return null;

  const [allOutputs, filming] = await Promise.all([
    outputsForProject(projectId).catch(() => [] as OutputRowView[]),
    // A summary that cannot read the filming brief still answers everything
    // else it is asked; the brief is one more line, not a precondition.
    filmingBriefFor(projectId).catch(() => null),
  ]);
  const outputs = allOutputs.filter((o) => o.state !== "removed");
  const live = outputs.filter((o) => o.state !== "waived");
  const done = live.filter((o) => o.state === "sent").length;
  const furthest = live.find((o) => o.round != null) ?? null;

  const scope = p.deliverables
    .filter((d) => !d.waivedAt)
    .map((d) => {
      const name = d.label || d.productTitle || d.type;
      const q = d.quantity ?? 1;
      return q > 1 ? `${name} ×${q}` : name;
    });

  // THE PROMISE, FROM THE ENGINE THAT ALREADY ARBITRATES IT (F05, review Sep
  // 20 2026).
  //
  // This used to be its own arithmetic — `promisedDueAt ?? dueOverrideAt ??
  // effectiveDue(dueOverrideAt, deliveryDue)` — and deliveryDue is the
  // JOB-level date the Aryeo sync writes off the VIDEO SLA. One inch below on
  // the same page, StatusEvidenceCard calls outstandingPromise, which dates a
  // job by its EARLIEST OUTSTANDING item, and so does every row of Kyle's
  // delivery board. Two promise engines, two cards, one job. deliveryBoard's
  // own header says outstandingPromise "cannot drift, because there is only
  // one of it", and the header at the top of this file says the summary uses
  // the engine that already arbitrates — and then this line did not call it.
  //
  // Measured read-only on production Sep 20 2026: of 36 open jobs where both
  // cards produced a date, 21 disagreed, and three contradicted each other on
  // late versus on time in the same minute — 1462 Brandywine Ln (board LATE
  // Sep 18 for the same-day floor plan, page on time Sep 21 "Video"), 204
  // Spring Ln (board LATE Sep 17, page on time Sep 12) and 1337 Carolannes Way
  // (board on time Sep 25, page LATE Aug 21). A synthetic sweep of nine
  // mixed-media jobs differed 9 times out of 9, by 10 to 28 hours.
  //
  // AND ONE DOCUMENTED RULE IN THIS FILE WAS RETIRED WITH THAT LINE, so it is
  // written down here rather than allowed to vanish (review, Sep 20 2026). The
  // old arithmetic put the frozen promise FIRST and its comment said so: "the
  // office's override beats a computed date but not a promise already made
  // (the rule the premium work established)". outstandingPromise does the
  // opposite — deliveryBoard.ts:338 returns dueOverrideAt ahead of everything
  // on a job that is not settled — and editOverrides.ts:177 already did too
  // (`dueOverrideAt ?? pinnedPromise(p) ?? computed`), so this file was the
  // only surface still ranking them the other way. Three open jobs now read
  // the office's LATER date and are labelled as the office's: 99 W Bridge St
  // (frozen Sep 11 16:00 -> Sep 19 14:26), 204 Spring Ln (Sep 12 13:00 ->
  // Sep 17 23:00) and 1337 Carolannes Way, the REVISION row (Aug 21 18:00 ->
  // Sep 25 20:26). On the last of those a red flag goes away. That is the
  // intended answer — when Jordan sets a date by hand he has seen the pin and
  // ruled anyway — but it IS a change of rule, not a refactor.
  //
  // So: ask once, and take the label with the date. `dueFor` used to be a
  // ternary on whether the job owed video, which labelled a mixed job's floor
  // plan promise "Video" on 25 live jobs; the engine knows which product the
  // date belongs to and says so.
  //
  // A JOB WITH NO LIVE CLOCK NOW HAS NO DATE HERE EITHER, and that is the
  // point rather than a loss. outstandingPromise returns null for a REOPENED
  // job (delivered, then asked to change) on the rule that a revision has no
  // clock of its own until Jordan sets one, and for a job with no shoot booked
  // at all. Six open jobs read that way on Sep 20 and four of them were
  // printing a red "past it": 84 Longfellow Cir, 358 N Church St, 322 N 62nd
  // St and 56 Hillview Rd were each DELIVERED BEFORE the date they were being
  // called late against. The other two, 7 Mendenhall Dr and 2705 Graystone Rd,
  // have never been shot. The first telling of this said their only date came
  // from the Aryeo sync's job-level deliveryDue; that is wrong, and the review
  // caught it — read on production Sep 20, both rows carry a real
  // Project.promisedDueAt (Sep 14 20:30Z and Jul 19 12:30Z) and deliveryDue
  // merely holds the same value. The right reason is the one the rest of the
  // hub already applies: an UNSHOT job has no clock anywhere. queries.ts:535
  // gates both late columns on `shootDate: { lte: now }`, so neither row has
  // ever reached a late list, and projectStatus.ts:1765 only writes a pin once
  // the clock has started — which means these two pins came from the
  // scripts/pin-promises.ts backfill, not from a promise made after a shoot.
  // The Status check card beneath has always shown no date on those six; now
  // both cards say the same nothing.
  const turnarounds = await turnaroundRules().catch(() => undefined);
  const promise = outstandingPromise(
    {
      status: p.status,
      shootDate: p.shootDate,
      deliveredAt: p.deliveredAt,
      revisionRequestedAt: p.revisionRequestedAt,
      dueOverrideAt: p.dueOverrideAt,
      tierOverride: p.tierOverride,
      promisedDueAt: p.promisedDueAt,
      promisedReason: p.promisedReason,
      packageName: p.packageName,
      statusEvidence: p.statusEvidence,
      orderItems: p.orderItems,
      // The board's OWED_DELIVERABLE_WHERE in memory: a waived line is not an
      // obligation and must not carry a promise.
      deliverables: p.deliverables
        .filter((d) => !d.waivedAt)
        .map((d) => ({ type: d.type, status: d.status, uploadedAt: d.uploadedAt, label: d.label })),
      appointments: p.appointments,
    },
    { turnarounds },
  );
  // …EXCEPT THAT A FINISHED JOB STILL KEEPS THE PROMISE IT WAS GIVEN (F05,
  // review Sep 20 2026). The engine's null means "no clock is running", which is the
  // right answer for a verdict and the wrong one for a history. Measured Sep
  // 20: 506 projects would lose the Promise line, and on all 500 of the
  // settled ones the date came from Project.promisedDueAt — the frozen,
  // client-facing promise, a STORED FACT and not a second engine's opinion.
  // This card is the only place on the project page that prints it, so
  // dropping it would delete "we said Sep 12" from 487 delivered job pages to
  // fix a disagreement those pages do not have: nothing else computes a date
  // for a settled job, so there is nobody to disagree with.
  //
  // Narrow on purpose. DELIVERED and CANCELLED only — the two statuses the
  // overdue rule below already excludes, so this date can never colour a card
  // red. A REOPENED job (delivered, then asked to change) is deliberately NOT
  // included: there the stored date is one the job already MET, and printing
  // it is exactly the "LATE · Aug 21" that started this.
  const settledPromise =
    !promise.at && (p.status === "DELIVERED" || p.status === "CANCELLED") ? p.promisedDueAt ?? null : null;
  const promisedAt = promise.at ?? settledPromise;
  // Where the date came from, in the engine's own terms: the office set it by
  // hand, or it is the frozen promise capping a later recomputed one, or it is
  // today's turnaround on the earliest outstanding item. With no live clock at
  // all the only date left is the frozen one, and it says so.
  //
  // A DATE THAT EQUALS THE PIN IS THE PIN, whether or not it had to cap
  // anything (review, Sep 20 2026). `promise.pinned` is set only when the pin
  // BEAT a later computed date (deliveryBoard.ts:365, `capped = at !==
  // earliest.dueAt`), so when the two coincide the source used to fall through
  // to "computed" and the card printed "on the standard turnaround" over a
  // date the client was actually quoted. One row today: 1217 River Rd shows
  // Sep 20 06:00, exactly its Project.promisedDueAt. Measured across all 538
  // pinned projects, this test moves that row and no other, and promiseSource
  // is read in one place (ProjectBriefCard.tsx:29) to choose a word — it
  // cannot move a date or a verdict.
  const promiseSource: ProjectBrief["promiseSource"] = !promisedAt
    ? null
    : !promise.at
      ? "frozen"
      : promise.office
        ? "office"
        : promise.pinned || (!!p.promisedDueAt && promise.at.getTime() === p.promisedDueAt.getTime())
          ? "frozen"
          : "computed";

  // ---- THE LIVE COUNT BEATS THE CACHED ONE --------------------------------
  //
  // statusEvidence is written by the hourly sweep, so every blob in the
  // database today predates the per-video counting and carries no `units` at
  // all — which parses as "we did not count" and lets the tone fall back to the
  // category answer. 1337 Carolannes reads exactly that way right now: two
  // videos owed, none with the client, and a cached headline saying everything
  // is confirmed. The sweep repairs it within the hour, and a summary that is
  // wrong for an hour is still wrong.
  //
  // The output rows in hand ARE the count, and they were read a line ago. Fold
  // them into the evidence before asking for the verdict, so this card is never
  // reading a number older than the page it is on. Same arithmetic as
  // computeStatus (named vs anonymous, capped at owed) because it has to give
  // the same answer once the sweep catches up.
  const cached = parseEvidence(p.statusEvidence);
  const onListing = Math.max(0, cached?.aryeo?.videos ?? 0);
  const namedSent = live.filter((o) => o.deliveredAt).length;
  const finishedNow = live.filter((o) => o.state === "approved" || o.state === "sent" || o.awaitingSend).length;
  const withClient = live.length > 0 ? Math.min(live.length, Math.max(onListing, namedSent)) : 0;
  const evidence =
    cached && live.length > 0
      ? {
          ...cached,
          units: [
            ...cached.units.filter((u) => u.category.toLowerCase() !== "video"),
            {
              category: "Video",
              owed: live.length,
              withClient,
              finished: Math.min(live.length, finishedNow),
              outstanding: Math.max(0, live.length - withClient),
              source: "outputs",
              named: namedSent,
              onListing,
              ...(Math.max(0, Math.min(live.length, onListing) - namedSent) > 0
                ? { unmatched: Math.max(0, Math.min(live.length, onListing) - namedSent) }
                : {}),
              ...(live.some((o) => !o.deliveredAt)
                ? { unresolvedKeys: live.filter((o) => !o.deliveredAt).map((o) => o.key).slice(0, 32) }
                : {}),
            },
          ],
          // A finished video nobody has sent is an owed send whatever the cached
          // blob says — the output rows know it first.
          awaitingSend:
            live.some((o) => o.awaitingSend) && !cached.awaitingSend.includes("Video")
              ? [...cached.awaitingSend, "Video"]
              : cached.awaitingSend,
        }
      : cached;
  // WHAT THIS JOB ACTUALLY OWES. The same one-line test the upload portal
  // (upload/actions.ts, `wantsVideoGate`) and the handoff sweep (tasks.ts,
  // "photos-only → AutoHDR, no human editor") already apply — this card was the
  // one place that asked the video engines about a job that sold only stills.
  // Waived rows still count: a waived video is a video job with a row retired,
  // which is the same rule cutSlots keeps.
  const owesVideo = p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");

  const tone = evidenceTone({
    status: p.status,
    evidence,
    shootDate: p.shootDate,
    // THE LIVE CLOCK ONLY, never the settled-job history above: feeding a
    // finished job its old promise here would print "Overdue" over work that
    // shipped. The first telling of this said 487 delivered pages; the review
    // checked the engine and it is CANCELLED that this protects, not
    // DELIVERED. statusEvidence.ts:590 returns "Delivered — n items
    // unconfirmed" before the overdue branch is ever reached, so a DELIVERED
    // job cannot print "Overdue" whatever date it is handed. CANCELLED has no
    // such early return and falls straight through to it — 13 cancelled rows
    // carry a pin today. Smaller number, same decision.
    dueAt: promise.at,
    // WHAT THE DATE IS FOR, FROM WHOEVER SET IT (F05, review Sep 20 2026).
    // "Video" was hardcoded, which labelled a photo-only job's promise as a
    // video promise it never had; the first pass replaced it with a ternary on
    // owesVideo, which fixed the stills-only case and still said "Video" on a
    // mixed job whose earliest promise was the floor plan's — 25 live jobs on
    // Sep 20, including 1462 Brandywine Ln, where the neighbouring card and
    // Kyle's board both said "Same Day 2D Floor-Plan Delivery". The promise
    // engine picked the item; it is the one that can name it.
    dueFor: promise.label,
    // True because the engine RAN, not because it produced a date: a null date
    // from outstandingPromise is an answer ("nothing is outstanding"), and
    // falling back to the blob's videoDue would put the tenth opinion back.
    // Same argument StatusEvidenceCard passes.
    promiseResolved: true,
    attemptedAt: p.evidenceAttemptedAt,
    succeededAt: p.evidenceSucceededAt,
    error: p.evidenceError,
    checkedAt: p.statusCheckedAt,
  });

  // THE BLOCKER, from the engine that already decides it. A job whose footage
  // is in but whose instructions are not is blocked on a person, and that is
  // more specific than anything the status can say.
  //
  // ONLY EVER ASKED OF A VIDEO JOB (F05, Sep 20 2026). handoffReadiness speaks
  // for the EDIT, and `hasFullVideo` only chooses which video rules apply — it
  // never turns them off. Asked about a photo-only order the titles match no
  // reel, so `minimalReel` is false and it answers "waiting on the flow and
  // vision for the edit" on a job that sold stills. 1217 River Rd read that
  // way: photos, drone and a floor plan, and a card telling Kyle that James
  // still owed editing vision. Worse, nobody could ever clear it — the upload
  // portal never shows the video step on a photo job, so the instructions
  // field stays null forever. Measured Sep 20: 924 of 1,585 projects (907 of
  // them DELIVERED) printed that sentence.
  //
  // isMonthly comes from the shared helper the other two callers use. The
  // hand-rolled regexes that used to sit here (/premium|signature|luxur/i and
  // /monthly|starter|accelerator|branding/i) were a tenth opinion in the one
  // card whose whole contract is that it cannot be one, and passing an
  // explicit isPremium DEFEATS pipeline's own PREMIUM_SCRIPT_RE. Same shape as
  // tasks.ts, which is what writes Project.handoffBlockedReason, so the card
  // says what the stored blocker says.
  //
  // BOTH NAMES OF A LINE, NOT THE PREFERRED ONE (F05, review Sep 20 2026).
  // /settings/products carries a human's premium mapping onto the deliverable
  // LABEL — itemToDeliverables writes "Premium <Type>" — while productTitle
  // keeps whatever the order line was sold as. Reading productTitle first hid
  // the mapping behind the bundle name: 151 Garner Dr, 3218 Alton St and 308
  // Highland Rd all carry a "Premium Video" label under the productTitle
  // "DIAMOND BUNDLE - The Ultimate Real Estate Marketing Package", and 800
  // Grayson Ln's "Premium Social Reel" sits under "Premium Social Media Video
  // Upgrade". videoTier() calls all four premium and the upload portal demands
  // the script, so the card was asking for LESS than the portal on the one job
  // the office would check it against. videoStepSpec's own doc asks for both
  // names. Measured Sep 20: feeding both moves 4 of 661 video jobs and every
  // move ADDS the script gap; adding packageName on top, the way
  // upload/actions.ts does, moves nothing further, so it stays out.
  const titles = p.deliverables.flatMap((d) => {
    const names = [d.productTitle, d.label].filter((s): s is string => !!s && !!s.trim());
    return names.length > 0 ? names : [d.type];
  });
  const handoff = owesVideo
    ? handoffReadiness({
        titles,
        hasFullVideo: p.deliverables.some((d) => d.type === "VIDEO"),
        isMonthly: isMonthlyContentJob(p.deliverables, p.packageName),
        debriefSubmittedAt: p.debriefSubmittedAt,
        videoInstructions: p.videoInstructions,
        editorBrief: p.editorBrief,
        reelScript: p.reelScript,
        reelHook: p.reelHook,
        scriptConfirmedAt: p.scriptConfirmedAt,
        videosFilmed: p.videosFilmed,
        photographerName: p.photographer?.name ?? null,
      })
    : null;

  const briefRow = p.revisionBriefs[0] ?? null;
  const noteText = meaningfulBrief(p.revisionNote);
  const latestRequest =
    briefRow && (!p.revisionRequestedAt || briefRow.createdAt >= p.revisionRequestedAt)
      ? { at: briefRow.createdAt, text: clip(briefRow.headline || briefRow.originalText), source: briefRow.source }
      : p.revisionRequestedAt && noteText
        ? { at: p.revisionRequestedAt, text: clip(noteText), source: "revision" }
        : null;

  // WHOSE MOVE, AND THE ONE THING TO DO. Ordered by what actually blocks
  // progress: a missing handoff beats an unstarted edit, an open client ask
  // beats a verdict, and an owed send beats everything that is already done.
  const editorName = p.editor?.name ?? (p.editorVendorKey ? "the outside shop" : null);
  let owner: BriefOwner;
  let nextAction: string;
  let blocker: string | null = handoff?.blockedReason ?? null;
  // CP-09: the photographer's filmed-topics report gave up after six tries and
  // is on Kyle's desk (NEEDS_REVIEW) — until a person records them, the editor
  // is cutting videos the hub cannot name. A report still retrying on its own
  // is not a blocker: nobody has anything to do yet.
  if (!blocker && filming?.pending?.state === "NEEDS_REVIEW") {
    blocker = `The filmed topics did not save — ${filming.pending.topics.length} to record by hand from the photographer's report.`;
  }

  const awaitingSend = live.filter((o) => o.awaitingSend);
  const inReview = live.filter((o) => o.state === "in_review");
  const inRevisions = live.filter((o) => o.state === "in_revisions");

  if (awaitingSend.length > 0) {
    owner = { who: "Kyle", whose: "office" };
    nextAction = `Send ${awaitingSend.length === live.length ? "the finished video" : `${awaitingSend.length} finished video${awaitingSend.length === 1 ? "" : "s"}`} and press Mark as sent`;
    blocker = blocker ?? null;
  } else if (inRevisions.length > 0) {
    owner = { who: editorName ?? "Nobody yet", whose: editorName ? "editor" : "nobody" };
    nextAction = `Hand in the next version of ${inRevisions.length === 1 ? "the video" : `${inRevisions.length} videos`}`;
  } else if (inReview.length > 0) {
    owner = { who: "The office", whose: "office" };
    nextAction = `Give ${inReview.length === 1 ? "the cut" : `${inReview.length} cuts`} a verdict in the Review Room`;
  } else if (handoff?.blockedReason) {
    owner = {
      who: handoff.ownerName ?? (handoff.gaps[0]?.owedBy === "photographer" ? p.photographer?.name ?? "The photographer" : "The office"),
      whose: handoff.gaps[0]?.owedBy === "photographer" ? "field" : "office",
    };
    nextAction = handoff.gaps.map((g) => g.label).join("; ");
  } else if (p.status === "DELIVERED") {
    owner = { who: "Nobody", whose: "nobody" };
    nextAction = tone.kind === "clear" ? "Nothing — this one is finished" : "Check the listing before telling the client it is all there";
  } else if (!owesVideo) {
    // A PHOTO JOB HAS ITS OWN LINE OF WORK (F05, Sep 20 2026). Without this the
    // next branches hand a stills-only order to an editor and tell the office to
    // "Pick an editor on the row in the Editing Room" — there is no row, photos
    // go through AutoHDR and nobody is ever assigned. The wrap-up IS owed on a
    // photo shoot (upload/actions.ts gates it on PHOTOS/DRONE/TWILIGHT the same
    // way), so that one clause of the old sentence survives the fix — but only
    // once the shoot has happened, because asking a photographer to wrap up a
    // job booked for next week is the kind of nag that makes people stop
    // reading the card. 20 Thompson Mill was doing exactly that.
    const shot = !!p.shootDate && p.shootDate.getTime() <= Date.now();
    if (p.status === "CANCELLED") {
      owner = { who: "Nobody", whose: "nobody" };
      nextAction = "Nothing — this order was cancelled";
    } else if (!shot) {
      // A date nobody has set is the office's problem, not the photographer's —
      // 265 Koser Rd sat BOOKED with no shoot date and named Jordan as the man
      // who owed the shoot.
      owner =
        p.shootDate && p.photographer?.name
          ? { who: p.photographer.name, whose: "field" }
          : { who: "The office", whose: "office" };
      nextAction = p.shootDate ? "Shoot it on the date booked" : "Get a shoot date on the calendar";
    } else if (!p.debriefSubmittedAt) {
      owner = { who: p.photographer?.name ?? "The photographer", whose: "field" };
      nextAction = "Finish the wrap-up on the upload page";
      blocker = blocker ?? `Waiting on the wrap-up on the upload page${p.photographer?.name ? ` from ${p.photographer.name}` : ""}.`;
    } else {
      owner = { who: "The office", whose: "office" };
      nextAction =
        p.status === "REVISION"
          ? "Make the photo fixes the client asked for and send them back"
          : "Confirm the photos are on the listing and send them";
    }
  } else if (editorName) {
    owner = { who: editorName, whose: "editor" };
    nextAction = live.length > 1 ? `Edit and hand in ${live.length} videos` : "Edit and hand it in";
  } else {
    owner = { who: "Nobody yet", whose: "nobody" };
    nextAction = "Pick an editor on the row in the Editing Room";
    blocker = blocker ?? "No editor is on this job";
  }

  return {
    projectId: p.id,
    scope,
    outputs,
    outputsDone: done,
    outputsOwed: live.length,
    currentVersion: furthest?.round ? `v${furthest.round} — ${furthest.label}` : null,
    promisedAt,
    promiseSource,
    targetAt: p.promisedTargetAt ?? null,
    // PAST THE DATE IS PAST THE DATE. Keying this on `tone.kind === "overdue"`
    // let a job slip out of it whenever the tone had something more specific to
    // say, and keying it on the COUNT let an anonymous listing video stop the
    // clock on a video nobody has made. 204 Spring Ln is both at once: one video
    // owed, one unidentified video on the listing, nothing started on our side,
    // six days past the date the client was given.
    //
    // A DELIVERED job is never late — the same rule every other surface keeps,
    // and without it the 234 jobs whose per-video rows carry no delivery stamp
    // would all light up red for a delivery that really happened. A CANCELLED
    // one is never late either: six of the eight past-due open photo jobs on
    // Sep 20 were cancelled orders, and the moment the count below started
    // working for photo jobs they would all have gone red.
    //
    // AND A PHOTO JOB COULD NEVER BE LATE AT ALL (F05, Sep 20 2026). The count
    // reads the per-video rows, and those are minted only from VIDEO /
    // SOCIAL_REEL lines (reviewCuts.cutSlots), so on a stills-only order the
    // list is empty BY CONSTRUCTION — 0 of 924 have a row — and the last
    // conjunct was pinned false however late the job ran. 1217 River Rd printed
    // the headline "Overdue" above a Promise line in plain black. When there is
    // no per-video row to ask, ask the engine that does know what is still
    // owed: anything but a clear verdict means something is still out. Keyed on
    // "not clear" rather than on tone.kind === "overdue" on purpose — that was
    // the old bug, where a tone with something more specific to say let a job
    // slip out of being late.
    //
    // AND A REVISION BEATS A CLEAR LISTING (F05, review Sep 20 2026). The
    // evidence engine reads the LISTING, so it says "everything ordered is
    // confirmed" whenever the media is up — it has no way to know the client
    // asked for one of those photos to be redone. 84 Longfellow Cir was a day
    // past its promise in REVISION and still read black, under a headline
    // saying it was all confirmed, while this same card's next-action line said
    // "make the photo fixes the client asked for and send them back". A card
    // that names owed work cannot call the job on time. Keyed on the STATUS and
    // not on `latestRequest`: a revision brief is never retracted, so an ask
    // from August still reads truthy long after the fix shipped and would pin a
    // job red with no way to clear it — the same unclearable nag F05 was about.
    // Both tests pick the same single job on today's book (measured Sep 20: one
    // photo-only job in REVISION, and every other photo-only job carrying an
    // open ask is DELIVERED and excluded above), so the status is the one that
    // costs nothing and still lets go.
    //
    // AND THE DATE IT RUNS AGAINST IS NOW KYLE'S (F05, review Sep 20 2026).
    // The rule below is unchanged; `promisedAt` is simply the promise engine's
    // answer instead of this file's own, so the page and the board can no
    // longer call the same job late on different days. The one thing that
    // moves: a reopened job (delivered, then asked to change) has no date at
    // all under that engine, so it cannot be overdue here either — which is
    // right, because the promise it is being measured against is one it
    // already kept. 1337 Carolannes Way read "LATE · Aug 21" for the client's
    // September notes until this line.
    overdue:
      p.status !== "DELIVERED" &&
      p.status !== "CANCELLED" &&
      !!promise.at &&
      promise.at.getTime() < Date.now() &&
      (live.length > 0
        ? // AND THE OFFICE'S OWN DATE IS NOT SECOND-GUESSED (F05, review Sep 20
          // 2026). When Jordan sets a date by hand on a job, that IS the
          // office saying work is owed by then, and outstandingPromise returns
          // it ahead of every product promise. Counting the per-video rows on
          // top of it let one job's single sent-and-stamped reel say "nothing
          // is owed" while the job sat in REVISION past the date the office
          // had set — 204 Spring Ln, board LATE Sep 17, page black. Measured
          // the same day: this moves exactly that one job, and it only ever
          // moves a card from on-time to late, never the other way.
          //
          // AND ON THAT ONE JOB THE CARD NOW ARGUES WITH ITS OWN HEADLINE,
          // knowingly (review, Sep 20 2026). ProjectBriefCard.tsx:37 prints
          // tone.headline directly above the Promise line, and on 204 Spring
          // Ln that headline is "Everything ordered is confirmed." over a red
          // "Sep 17 — set by the office · past it". The red flag is the right
          // answer: Kyle's board says LATE on the same minute, and so does the
          // office's own date. What is wrong is the headline — evidenceTone
          // reads the LISTING, and a listing full of media cannot tell that
          // the client asked for a change, which is a defect in the tone
          // engine (statusEvidence.ts) and not in this date. Mirroring the
          // photo-only guard here would silence the flag instead of fixing the
          // headline: measured Sep 20, that form moves ZERO jobs, so it would
          // trade a visible contradiction for a silent miss. Left as is on
          // purpose, and filed against the tone engine.
          live.some((o) => o.state !== "sent") || promise.office
        : !owesVideo && (tone.kind !== "clear" || p.status === "REVISION")),
    latestRequest,
    blocker,
    owner,
    nextAction,
    tone,
    filming,
  };
}
