import "server-only";
import { parseEvidence } from "@/lib/statusEvidence";

// ---------------------------------------------------------------------------
// RULE 1 — THE DELIVERY DATE IS STAMPED ONCE.
//
// Project.deliveredAt is not "the last time somebody said done". It is the day
// the client got their content, and four surfaces read it as exactly that:
//   · the on-time percentage  (queries.ts + bonus.ts compare deliveredAt <= deliveryDue)
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
// RULE 2 — "DELIVERED" MEANS EVERYTHING ORDERED HAS LANDED (Jordan's rule).
//
// The status engine already computes this per job and writes it to
// Project.statusEvidence: `missing` is the list of ordered media categories
// ("Photos", "Video", "Floor plan", "3D tour") that are live neither on Aryeo
// nor in the job's Dropbox Final folder. Any human "mark it delivered" control
// must consult it, or the hub says delivered while the reel is still unmade.
//
// `provenLanded` is the escape hatch for freshness, NOT for judgement: the
// evidence read is hourly, so a caller holding harder proof that a category
// just landed (e.g. an APPROVED Review-Room cut for every video owed — approval
// copies the file into the job's Final folder) passes that label in and it
// drops off the list. Unreadable/absent evidence yields an EMPTY list on
// purpose: we block on positive proof that something is owed, never on
// ignorance, because manual and non-Aryeo jobs legitimately have no evidence.
// ---------------------------------------------------------------------------
export const VIDEO_CATEGORY = "Video";

export function outstandingForDelivery(
  statusEvidence: string | null | undefined,
  provenLanded: string[] = [],
): string[] {
  const missing = parseEvidence(statusEvidence)?.missing ?? [];
  const proven = new Set(provenLanded.map((s) => s.trim().toLowerCase()));
  return missing.filter((m) => !proven.has(m.trim().toLowerCase()));
}

// The refusal, in Jordan's voice (no em dashes, no emojis) and always with the
// way forward. Owner/admin keep a documented override on the project page
// (moveProjectStatus) for the case where the evidence itself is wrong.
export function outstandingMessage(outstanding: string[]): string {
  const items = outstanding.map((s) => s.trim().toLowerCase()).filter(Boolean);
  // Nothing outstanding = nothing to refuse. Exported helpers get called from
  // places their author never saw; never build a sentence about "undefined".
  if (items.length === 0) return "Everything ordered has landed.";
  const list = items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0];
  // Verb agreement, same rule as the delivery text below: "the photos ARE
  // still outstanding" / "the video IS still outstanding".
  const verb = items.length > 1 || /s\s*$/i.test(items[0] ?? "") ? "are" : "is";
  // The way forward depends on the lane: a cut goes through the Review Room,
  // everything else lands by being delivered on Aryeo.
  const how = items.includes(VIDEO_CATEGORY.toLowerCase())
    ? "Send the cut to review, or deliver it on Aryeo, and this flips on its own."
    : "Deliver it on Aryeo and this flips on its own.";
  return `Not delivered yet: the ${list} ${verb} still outstanding. ${how} If everything really is out, mark it delivered from the project page.`;
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
// part of it (e.g. the video) is still in production.
// Apply an owner-authored template (Settings → Text templates). An empty
// template means "use the built-in wording" — a blank box can never send a
// blank text.
export function applyTemplate(tpl: string, vars: Record<string, string>): string {
  const out = tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).trim();
  return out;
}

export function deliveryMessage(p: DeliveryProject, templates?: { deliveryAll?: string; deliveryPartial?: string }): string {
  const first = (p.client.name || "there").trim().split(/\s+/)[0] || "there";
  const street = streetOf(p.title);
  const city = p.city?.trim() ?? "";
  // "for 123 Main St" / "from your West Chester shoot" / "from your shoot" (rule 3).
  const forPlace = street ? ` for ${street}` : city ? ` from your ${city} shoot` : " from your shoot";
  const url = feedbackUrl(p.id);
  const ev = parseEvidence(p.statusEvidence);
  const missing = ev?.missing ?? [];

  // Jordan (Sep 1): lead with asking how we did, not "we just sent everything
  // over" — the text's job is to invite feedback, not announce the delivery.
  if (missing.length > 0) {
    const presentItems = ev?.present ?? [];
    const present = presentItems.length ? presentItems.join(", ").toLowerCase() : "first round of content";
    // Verb agreement: "the photos ARE delivered" / "the video IS delivered".
    const presentVerb = presentItems.length > 1 || /s\s*$/i.test(presentItems[0] ?? "") ? "are" : "is";
    const left = missing.join(", ").toLowerCase();
    const leftVerb = missing.length > 1 || /s\s*$/i.test(missing[0]) ? "are" : "is";
    const tplPartial = templates?.deliveryPartial?.trim();
    if (tplPartial) {
      return applyTemplate(tplPartial, { first, street: streetForTemplate(street, city), delivered: present, remaining: left, feedbackUrl: url });
    }
    return `Hi ${first}! The ${present}${forPlace} ${presentVerb} delivered, and the ${left} ${leftVerb} still in production and coming shortly. How is everything looking so far? If anything is not exactly right, just reply here and we will jump on it. Quick feedback means a lot to us: ${url}`;
  }
  const tplAll = templates?.deliveryAll?.trim();
  if (tplAll) return applyTemplate(tplAll, { first, street: streetForTemplate(street, city), feedbackUrl: url });
  return `Hi ${first}! Everything${forPlace} has been delivered. How did we do? If anything is not exactly right, just reply here and we will jump on it. And if you have a quick minute, we would love your feedback here: ${url}`;
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
        // NOTE for whoever owns the send paths: this filter only bites when
        // the caller SELECTS waivedAt. Three selects still don't, and each
        // needs `where: { removedFromOrderAt: null, waivedAt: null }` (the
        // shared tasks.OWED_DELIVERABLE_WHERE) — lib/clientTextSweeps.ts (the
        // auto-send), app/actions.ts and app/tasks/sendAllActions.ts. Left to
        // them on purpose: those files are outside this batch's file set.
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
export function confirmationMessage(p: ConfirmProject, template?: string): string {
  const first = (p.client.name || "there").trim().split(/\s+/)[0] || "there";
  const street = streetOf(p.title);
  const city = p.city?.trim() ?? "";
  // "at 123 Main St" / "in West Chester" / nothing (rule 3).
  const where = street ? ` at ${street}` : city ? ` in ${city}` : "";
  const when = p.shootDate
    ? new Date(p.shootDate).toLocaleString("en-US", {
        timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : "your upcoming shoot";
  const items = orderedList(p.deliverables);
  const forPart = items ? ` for ${items}` : "";
  const tpl = template?.trim();
  if (tpl) return applyTemplate(tpl, { first, street: streetForTemplate(street, city), when, items: items || "your shoot" });
  const ask = "Anything we should know or want us to avoid? Looking forward to it!";
  // No date on the job yet: say so instead of gluing "your upcoming shoot"
  // where the date went ("...at 123 Main St your upcoming shoot for photos").
  return p.shootDate
    ? `Hi ${first}! Confirming your shoot${where} on ${when}${forPart}. ${ask}`
    : `Hi ${first}! Confirming your upcoming shoot${where}${forPart}. ${ask}`;
}
