import "server-only";
import { parseEvidence } from "@/lib/statusEvidence";

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
