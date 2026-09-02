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
  statusEvidence: string | null;
  client: { name: string };
};

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
  const street = (p.title || "your listing").split(",")[0].trim();
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
      return applyTemplate(tplPartial, { first, street, delivered: present, remaining: left, feedbackUrl: url });
    }
    return `Hi ${first}! The ${present} for ${street} ${presentVerb} delivered, and the ${left} ${leftVerb} still in production and coming shortly. How is everything looking so far? If anything is not exactly right, just reply here and we will jump on it. Quick feedback means a lot to us: ${url}`;
  }
  const tplAll = templates?.deliveryAll?.trim();
  if (tplAll) return applyTemplate(tplAll, { first, street, feedbackUrl: url });
  return `Hi ${first}! Everything for ${street} has been delivered. How did we do? If anything is not exactly right, just reply here and we will jump on it. And if you have a quick minute, we would love your feedback here: ${url}`;
}

type ConfirmProject = {
  title: string;
  shootDate: Date | null;
  client: { name: string };
  photographer?: { name: string } | null;
  deliverables?: { type: string }[];
};

// Friendly, agent-facing names for what was ordered (for the confirmation text).
const ORDER_LABEL: Record<string, string> = {
  PHOTOS: "photos", DRONE: "drone", FLOORPLAN: "floor plan", MATTERPORT_3D: "3D tour",
  ZILLOW_3D: "Zillow 3D tour", TWILIGHT: "twilight", VIRTUAL_STAGING: "virtual staging",
  SOCIAL_REEL: "social reel", VIDEO: "video", HEADSHOT: "headshots",
};
function orderedList(deliverables?: { type: string }[]): string {
  const names = Array.from(new Set((deliverables ?? []).map((d) => ORDER_LABEL[d.type]).filter(Boolean)));
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
  const street = (p.title || "your listing").split(",")[0].trim();
  const when = p.shootDate
    ? new Date(p.shootDate).toLocaleString("en-US", {
        timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : "your upcoming shoot";
  const items = orderedList(p.deliverables);
  const forPart = items ? ` for ${items}` : "";
  const datePart = p.shootDate ? `on ${when}` : when;
  const tpl = template?.trim();
  if (tpl) return applyTemplate(tpl, { first, street, when, items: items || "your shoot" });
  return `Hi ${first}! Confirming your shoot at ${street} ${datePart}${forPart}. Anything we should know or want us to avoid? Looking forward to it!`;
}
