import "server-only";
import { parseEvidence, owedNow, owedPhrase, owedVerb, sameCategory, type OwedShortfall } from "@/lib/statusEvidence";
import { DEFAULT_TEXTS, templateSet, type TemplateOverride, type TextTemplateKey, type TextTemplateSet } from "@/lib/textTemplates";

// ---------------------------------------------------------------------------
// RULE 1 — THE DELIVERY DATE IS STAMPED ONCE.
//
// Project.deliveredAt is not "the last time somebody said done". It is the day
// the client got their content, and four surfaces read it as exactly that:
//   · the on-time percentage  (queries.ts + kpi.ts compare deliveredAt <= deliveryDue)
//   · the revenue window      (finance.ts buckets a month by deliveredAt)
//   · the client portal       (portalLibrary.ts orders the library by it)
//   · every "Delivered <date>" line on a job, a payout and an AR row.
// Re-stamping it on a later click silently moves a job into a different month
// and can turn an on-time delivery into a late one. Live on Sep 2 2026: 25 jobs
// carried a deliveredAt LATER than their own first delivery marker, and 7 of
// those read LATE only because the stamp had moved (e.g. 1337 Carolannes Way,
// due Jul 2, first delivered Jul 1, stamp moved to Aug 24).
//
// So no path may write `deliveredAt: new Date()` directly. Spread this patch
// instead: the first delivery stamps, and every RE-delivery (a resolved
// revision, a queue "Completed" on an already-delivered job, a hand-move on the
// pipeline board) keeps the original date. A re-delivery that needs its own
// timestamp belongs on the revision/round row, never on this field.
//
// Honouring the rule today: src/lib/projectStatus.ts (guarded on
// `!p.deliveredAt`), src/app/editing/actions.ts (setQueueStatus, via this
// helper) and src/lib/comms.ts resolveRevision (which no longer writes the
// field at all — a resolved revision is not a new delivery).
// STILL TO ADOPT: src/app/actions.ts moveProjectStatus — hand-moving a job to
// Delivered on the pipeline board still writes `new Date()` unconditionally,
// and it is the second-biggest source of moved stamps in the live data
// (7 jobs, up to 58.7 days).
// ---------------------------------------------------------------------------
export function deliveryStamp(
  existing: Date | null | undefined,
  at: Date = new Date(),
): { deliveredAt?: Date } {
  return existing ? {} : { deliveredAt: at };
}

// ---------------------------------------------------------------------------
// RULE 2 — "DELIVERED" MEANS EVERYTHING ORDERED HAS LANDED IN THE CLIENT'S
// HANDS (Jordan's rule).
//
// The status engine computes what is owed per job and writes it to
// Project.statusEvidence. This gate used to read exactly one field off that
// blob — `missing`, the categories live neither on Aryeo nor in our Dropbox —
// and that is the audit F03 defect, found Sep 20. The engine's `present` set
// is clientHas UNION weHave, so a video that gets CUT, approved and copied
// into 05-Final-Video drops out of `missing` the moment the editor finishes
// it. The gate's only input was emptied by the work being done rather than by
// the client receiving it, and three live jobs were one pill click from a
// false DELIVERED: 5 Raymond Cir, 453 Cardigan Terrace and 5642 Limeport Rd,
// the last with four videos cut, four in Dropbox and zero on the client's
// listing. Clients are not on the portal, so the Aryeo listing IS their only
// access — `onListing: 0` means they genuinely cannot open the file.
//
// So the gate now reads owedNow() — the same definition the status card and
// statusFlag use (src/lib/statusEvidence.ts), so the two can never drift
// again. Both obligations block: never made, and finished and never sent. The
// per-video tally rides along as the COUNT on the sentence ("3 of 4 videos"),
// not as a reason of its own; owedNow says why.
//
// THE FRESHNESS ESCAPE HATCH IS RETIRED (Sep 20, review of the F03 fix).
// This gate used to take a `provenLanded` list — a caller holding harder
// proof that a category had just landed could name it and drop it off. Its
// only supplier was the Editing Room pill, which passed VIDEO when every cut
// owed had an APPROVED Review-Room round. Approval copies the file into the
// job's 05-Final-Video folder, so what it proves is that WE have it, which is
// the very fact `awaitingSend` exists to flag. It was being spent to clear an
// obligation to the CLIENT. Measured across the 55 live blobs carrying Video
// in `missing` on Sep 20, the hatch was already inert on the 26 that carry a
// unit tally, and the tally is being written to more of them every hour. So
// it goes, rather than staying on the page describing a permission nobody
// should have had: an approved cut is not a delivery, and the way past a
// stale blob is "Refresh from Aryeo" on the project page or the owner's
// documented override, both of which the refusal names.
//
// Unreadable/absent evidence yields an EMPTY list on purpose: we block on
// positive proof that something is owed, never on ignorance, because manual
// and non-Aryeo jobs legitimately have no evidence.
// ---------------------------------------------------------------------------
export const VIDEO_CATEGORY = "Video";

export type DeliveryBlockers = {
  /** every category still owed, however it is owed. Empty = nothing to refuse. */
  categories: string[];
  /** the subset ordered and live nowhere */
  neverMade: string[];
  /** the subset finished in our Dropbox and on no client listing */
  awaitingSend: string[];
  /** per-category counts, so a refusal can say "3 of 4 videos" */
  shortfall: OwedShortfall[];
};

export function outstandingForDelivery(statusEvidence: string | null | undefined): DeliveryBlockers {
  const owed = owedNow(parseEvidence(statusEvidence));
  return {
    categories: owed.categories,
    neverMade: owed.neverMade,
    awaitingSend: owed.awaitingSend,
    shortfall: owed.shortfall,
  };
}

/** The same blockers with the owed-SEND half dropped — what is left is only
 *  what nobody can find anywhere.
 *
 *  For the one caller that has a human's word in hand (Sep 20): the office
 *  marking Completed on a job whose corrected video it delivered by hand is
 *  the same witness the engine honours when it silences `awaitingSend` on an
 *  office-confirmed delivery (projectStatus.ts, the Sep 16 Kyle call). It
 *  cannot conjure a category nobody has made, so that half still blocks. */
export function neverMadeOnly(blockers: DeliveryBlockers): DeliveryBlockers {
  return {
    categories: blockers.neverMade,
    neverMade: blockers.neverMade,
    awaitingSend: [],
    shortfall: blockers.shortfall.filter((s) => blockers.neverMade.some((c) => sameCategory(c, s.category))),
  };
}

// The refusal, in Jordan's voice (no em dashes, no emojis) and always with the
// way forward. Owner/admin keep a documented override on the project page
// (moveProjectStatus) for the case where the evidence itself is wrong.
export function outstandingMessage(blockers: DeliveryBlockers): string {
  // Nothing outstanding = nothing to refuse. Exported helpers get called from
  // places their author never saw; never build a sentence about "undefined".
  if (blockers.categories.length === 0) return "Everything ordered has landed.";
  const list = owedPhrase(blockers);
  const verb = owedVerb(blockers);
  // SAY WHICH PROBLEM IT IS (F03, Sep 20). "Still outstanding" on a job where
  // the editor just finished every video reads as an accusation that the work
  // was never done, and the editor's next move is to go looking for a file
  // that is already sitting there. The "finished" half of the sentence is
  // said only where `awaitingSend` carries every category, because that list
  // is the one that actually knows the file is in our Final folder; a job
  // with anything unmade gets the neutral wording.
  const waitingOnAPublish = blockers.neverMade.length === 0 && blockers.awaitingSend.length > 0;
  const state = waitingOnAPublish
    ? `${verb} finished in our Dropbox and not on the client's listing`
    : `${verb} still outstanding`;
  // The way forward depends on the lane: an unmade cut goes through the Review
  // Room, everything else lands by being published on Aryeo. And since the
  // blob is read hourly, name the button that re-reads it now (Sep 20): with
  // the freshness hatch retired, a job published on Aryeo five minutes ago is
  // refused until somebody refreshes it, and the refusal has to say so rather
  // than leaving Kyle to wait out the sweep.
  const plural = verb === "are";
  const how = waitingOnAPublish
    ? `Deliver ${plural ? "them" : "it"} on Aryeo and this flips on its own.`
    : blockers.neverMade.some((c) => sameCategory(c, VIDEO_CATEGORY))
      ? "Send the cut to review, or deliver it on Aryeo, and this flips on its own."
      : `Deliver ${plural ? "them" : "it"} on Aryeo and this flips on its own.`;
  return `Not delivered yet: ${list} ${state}. ${how} If ${plural ? "they are" : "it is"} already up, press Refresh from Aryeo on the project page, and if everything really is out, mark it delivered from there.`;
}

// Public feedback form link for a project (lands in the post-delivery text).
export function feedbackUrl(projectId: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return `${base}/feedback/${projectId}`;
}

type DeliveryProject = {
  id: string;
  title: string;
  /** Aryeo's city — the fallback place-name when the title carries no street. */
  city?: string | null;
  statusEvidence: string | null;
  client: { name: string };
};

// ---------------------------------------------------------------------------
// RULE 3 — A CLIENT TEXT NEVER CARRIES "[No address provided]".
//
// Aryeo titles a pin-only order with its own placeholder — the title of
// Sharra Mercer's Sep 9 content session is literally
// "[No address provided], 39.959884,-75.6062135" — and addressTitle() passes
// it through verbatim, so `title` is not always an address. On Sep 7 2026 the
// auto-confirmation split that title on the comma and texted her "Confirming
// your shoot at [No address provided] on Wednesday, Sep 9, 2:30 PM"; Sarina
// Spinelli (Sep 11) and Mike Flatley (Sep 15) were queued to get the same.
// The street is resolved HERE, once, and every sentence below — the built-in
// wording, an owner template's {street}, the delivery text — reads through
// it: a real street says "at 123 Main St", a pin-only job with a city says
// "in West Chester", and with nothing at all the place clause is dropped.
// (`city` is optional so today's callers keep compiling; the ones that pass
// it get the better sentence.)
// ---------------------------------------------------------------------------
const NO_STREET_RE = /^\s*\[?\s*no address/i;

/** The street off a job title, or "" when the title is Aryeo's pin-only placeholder (or empty). */
export function streetOf(title: string | null | undefined): string {
  const street = (title ?? "").split(",")[0].trim();
  return !street || NO_STREET_RE.test(street) ? "" : street;
}

/** What an owner template's {street} becomes: the street, else a phrase that
 *  still reads after "at" / "for" — "the West Chester location", or the old
 *  "your listing" fallback when Aryeo gave us neither. */
function streetForTemplate(street: string, city: string): string {
  return street || (city ? `the ${city} location` : "your listing");
}

// The post-delivery client text, written in Jordan's voice (no em dashes, no
// emojis, warm + low-pressure). Adapts to whether everything is delivered or
// part of it (e.g. the video) is still in production. (applyTemplate, the old
// box's filler, retired Oct 22 2026: an old box's words are filled by
// lib/textTemplates fillTemplate as a "legacy" wording, which leaves an
// unknown {name} as typed exactly like it did.)
//
// EVERY BRANCH IS A TEMPLATE (Oct 22 2026). `t` is the wording in use
// (lib/textTemplateStore loadTextTemplates: a saved change, an old box's, or
// the default), and it decides all three texts:
//   · everything delivered → client_delivery_feedback, the feedback ask. The
//     per-card Send used to send its own older announcement here ("Everything
//     for … has been delivered. How did we do?"), an earlier copy of the same
//     moment that Jordan replaced on Sep 1; it now sends the ask, like the
//     sweep and Send all;
//   · part of it still owed → client_delivery_partial (only a person pressing
//     Send reaches it: the sweep waits for the whole job);
//   · nothing on the listing yet → client_delivery_update.
// Without `t`, the defaults. `templates` is the old Text wording box, kept
// for callers that pass it: with `t` the store already carries that box's
// wording (as "legacy"), so it is not applied twice; without `t` it is folded
// into the defaults the way the store would.
export function deliveryMessage(p: DeliveryProject, templates?: { deliveryAll?: string; deliveryPartial?: string }, t?: TextTemplateSet): string {
  const set = t ?? oldBoxSet(templates);
  const first = (p.client.name || "there").trim().split(/\s+/)[0] || "there";
  const street = streetOf(p.title);
  const city = p.city?.trim() ?? "";
  // "for 123 Main St" / "from your West Chester shoot" / "from your shoot" (rule 3).
  const forPlace = street ? ` for ${street}` : city ? ` from your ${city} shoot` : " from your shoot";
  const url = feedbackUrl(p.id);
  const ev = parseEvidence(p.statusEvidence);
  // THE SAME DEFINITION THE GATE USES (F03, Sep 20). This read `ev.missing`,
  // which is "never made" — so a job with four videos cut, one on the listing
  // and three still to send took the ALL branch and told the agent
  // "Everything for <street> has been delivered. How did we do?" That is the
  // 626 Greycliffe Ln text on Sep 4, and Gary replying the same afternoon
  // "I'm looking for the social media video". The send gate in
  // clientTextSweeps now holds these, and the copy no longer claims it either.
  const owed = owedNow(ev);
  const missing = owed.categories;

  // Jordan (Sep 1): lead with asking how we did, not "we just sent everything
  // over" — the text's job is to invite feedback, not announce the delivery.
  if (missing.length > 0) {
    // A category that is partly out is still owed, so it must not also be
    // read back to the client as delivered in the same sentence.
    const presentItems = (ev?.present ?? []).filter((c) => !missing.some((m) => sameCategory(m, c)));
    const present = presentItems.join(", ").toLowerCase();
    // Verb agreement: "the photos ARE delivered" / "the video IS delivered".
    const presentVerb = presentItems.length > 1 || /s\s*$/i.test(presentItems[0] ?? "") ? "are" : "is";
    // WITH THE COUNT, AND WITHOUT GUESSING WHY (Sep 20 review). Two things
    // were wrong here on the jobs the new definition routes to this branch.
    // "Still in production" is false for a video that is finished and merely
    // unpublished, which is most of them; and `left` dropped the count, so an
    // agent holding one of four reels was told "the video" was coming.
    const left = owedPhrase(owed);
    const leftVerb = owedVerb(owed);
    const leftState = owed.neverMade.length === 0 && owed.awaitingSend.length > 0
      ? "finished and going up on your listing"
      : "still in production and coming shortly";
    const remainingLine = `${left} ${leftVerb} ${leftState}`;
    // NOTHING TO ANNOUNCE IS NOT "THE FIRST ROUND IS DELIVERED" (5642 Limeport
    // Rd, Sep 20). The delivered half used to fall back to that phrase when
    // every present category was also still owed, so a video-only job with
    // four cuts in Dropbox and none on the listing told Gary the first round
    // of content was delivered when nothing had reached him at all. When
    // there is nothing out, the text says only what is still coming and asks
    // for no feedback there is nothing to give. It is its own template
    // (client_delivery_update) on purpose: the part-delivered one's whole
    // shape is "{delivered} is out and {remaining} is coming", and there is no
    // honest word for {delivered}.
    if (!presentItems.length) {
      return set.render("client_delivery_update", { first, forPlace: forPlace.trim(), remainingLine });
    }
    return set.render("client_delivery_partial", {
      first,
      deliveredLine: `${present}${forPlace} ${presentVerb} delivered`,
      remainingLine,
      feedbackUrl: url,
      // The old box's names, for a wording written with them.
      delivered: present,
      remaining: left,
      street: streetForTemplate(street, city),
    });
  }
  return set.render("client_delivery_feedback", { first, street: streetForTemplate(street, city), feedbackUrl: url });
}

/** The old Text wording box's delivery words, handed in without a set: sent
 *  as they always were (unchecked, like the store's "legacy"), else the
 *  defaults. */
function oldBoxSet(templates?: { deliveryAll?: string; deliveryPartial?: string }): TextTemplateSet {
  const o: Partial<Record<TextTemplateKey, TemplateOverride>> = {};
  if (templates?.deliveryAll?.trim()) o.client_delivery_feedback = { body: templates.deliveryAll, legacy: true };
  if (templates?.deliveryPartial?.trim()) o.client_delivery_partial = { body: templates.deliveryPartial, legacy: true };
  return Object.keys(o).length ? templateSet(o) : DEFAULT_TEXTS;
}

type ConfirmProject = {
  title: string;
  /** Aryeo's city — the fallback place-name when the title carries no street. */
  city?: string | null;
  shootDate: Date | null;
  client: { name: string };
  photographer?: { name: string } | null;
  /** owed rows only — a waived item is not something to confirm back to the
   *  client (Sep 16). Callers query with tasks.OWED_DELIVERABLE_WHERE; the
   *  filter here is the belt to that braces, for a caller who selected the
   *  column but not the filter. */
  deliverables?: { type: string; waivedAt?: Date | null }[];
};

// Friendly, agent-facing names for what was ordered (for the confirmation text).
const ORDER_LABEL: Record<string, string> = {
  PHOTOS: "photos", DRONE: "drone", FLOORPLAN: "floor plan", MATTERPORT_3D: "3D tour",
  ZILLOW_3D: "Zillow 3D tour", TWILIGHT: "twilight", VIRTUAL_STAGING: "virtual staging",
  SOCIAL_REEL: "social reel", VIDEO: "video", HEADSHOT: "headshots",
};
function orderedList(deliverables?: { type: string; waivedAt?: Date | null }[]): string {
  const names = Array.from(
    new Set(
      (deliverables ?? [])
        // "Confirming your shoot for photos, drone and floor plan" must not
        // name a floor plan the office has said isn't required (Sep 16).
        //
        // This filter only bites when the caller SELECTS waivedAt. The sweep,
        // the per-card Send and Send all all read the job through
        // CLIENT_TEXT_JOB_SELECT below (Oct 22 2026), which does; the task's
        // draft (lib/tasks.ts) selects only owed rows in the first place.
        .filter((d) => !d.waivedAt)
        .map((d) => ORDER_LABEL[d.type])
        .filter(Boolean),
    ),
  );
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// The day-before confirmation TEXT (we dropped confirmation calls — no one
// answers). Quick + brief, because agents are busy: confirm date/time, confirm
// what they ordered, and ask for any notes / things to avoid. Jordan's voice
// (no em dashes, no emojis), copy-paste ready.
//
// The words are the client_confirmation template (lib/textTemplates, Oct 21
// 2026). `t` is the wording in use, saved changes included
// (lib/textTemplateStore), which the sweep and both Send buttons pass (Oct 22
// 2026); without it, the default wording.
export function confirmationMessage(p: ConfirmProject, t?: TextTemplateSet): string {
  const first = (p.client.name || "there").trim().split(/\s+/)[0] || "there";
  const street = streetOf(p.title);
  const city = p.city?.trim() ?? "";
  // "at 123 Main St" / "in West Chester" / nothing (rule 3).
  const atPlace = street ? `at ${street}` : city ? `in ${city}` : "";
  const when = p.shootDate
    ? new Date(p.shootDate).toLocaleString("en-US", {
        timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : "your upcoming shoot";
  const items = orderedList(p.deliverables);
  const forItems = items ? `for ${items}` : "";
  const set = t ?? DEFAULT_TEXTS;
  // A wording of Jordan's is used with or without a date, as it always was
  // ({when} then reads "your upcoming shoot"); the automatic send always has
  // a date. The default wording has a date in it, so a job with none says so
  // instead of gluing "your upcoming shoot" where the date went.
  if (p.shootDate || set.sourceOf("client_confirmation") !== "default") {
    return set.render("client_confirmation", { first, when, atPlace, forItems, street: streetForTemplate(street, city), items: items || "your shoot" });
  }
  const where = atPlace ? ` ${atPlace}` : "";
  const forPart = forItems ? ` ${forItems}` : "";
  return `Hi ${first}! Confirming your upcoming shoot${where}${forPart}. Anything we should know or want us to avoid? Looking forward to it!`;
}

// ---------------------------------------------------------------------------
// ONE WORDING, WHOEVER SENDS IT (Oct 22 2026). The confirmation and the
// delivery text go out three ways: the hourly sweep (lib/clientTextSweeps),
// the Send button on the task's card (app/actions.ts) and Send all
// (app/tasks/sendAllActions.ts). The two buttons used to render the built-in
// words with no saved wording, no town and (the card) waived items read out,
// while the sweep sent Jordan's edited template. All three now read the job
// through this select and render through clientTextFor, with the wording the
// sweep loads (lib/textTemplateStore loadTextTemplates), so an edit in
// Settings → Text messages changes every one of them.
// ---------------------------------------------------------------------------
export type ClientTextKind = "confirmation_text" | "delivery_text";

export type ClientTextJob = {
  id: string;
  title: string;
  city?: string | null;
  shootDate?: Date | null;
  statusEvidence?: string | null;
  client: { name: string };
  photographer?: { name: string } | null;
  deliverables?: { type: string; waivedAt?: Date | null }[];
};

/** What a hand send selects off the job (Prisma `select`): the fields the
 *  sweep renders with, and the client's phone. */
export const CLIENT_TEXT_JOB_SELECT = {
  id: true, title: true, city: true, shootDate: true, statusEvidence: true,
  client: { select: { name: true, phone: true } },
  photographer: { select: { name: true } },
  deliverables: { where: { removedFromOrderAt: null }, select: { type: true, waivedAt: true } },
} as const;

/** The text a confirmation_text / delivery_text task sends for its job, in
 *  wording `t`. The delivery text has never read the town (the delivery
 *  sweep's job read and the task's draft select none), so `city` goes to the
 *  confirmation only and {street} is the same from every sender. */
export function clientTextFor(kind: ClientTextKind, job: ClientTextJob, t: TextTemplateSet): string {
  if (kind === "delivery_text") {
    return deliveryMessage({ id: job.id, title: job.title, statusEvidence: job.statusEvidence ?? null, client: { name: job.client.name } }, undefined, t);
  }
  return confirmationMessage({
    title: job.title, city: job.city, shootDate: job.shootDate ?? null,
    client: { name: job.client.name }, photographer: job.photographer, deliverables: job.deliverables,
  }, t);
}
