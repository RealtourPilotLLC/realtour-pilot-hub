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
export function deliveryMessage(p: DeliveryProject): string {
  const first = (p.client.name || "there").trim().split(/\s+/)[0] || "there";
  const street = (p.title || "your listing").split(",")[0].trim();
  const url = feedbackUrl(p.id);
  const ev = parseEvidence(p.statusEvidence);
  const missing = ev?.missing ?? [];

  if (missing.length > 0) {
    const present = ev?.present?.length ? ev.present.join(", ").toLowerCase() : "first round of content";
    const left = missing.join(", ").toLowerCase();
    return `Hi ${first}! We just delivered the ${present} for ${street}, and the ${left} is still in production. We will have the rest over to you shortly. Let us know if you need anything. If you would like to share quick feedback on your experience, you can do that here: ${url}`;
  }
  return `Hi ${first}! We just sent everything over for ${street}. Let us know if you need anything at all. If you would like to share quick feedback on your experience, you can do that here: ${url}`;
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
export function confirmationMessage(p: ConfirmProject): string {
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
  return `Hi ${first}! Confirming your shoot at ${street} ${datePart}${forPart}. Anything we should know or want us to avoid? Looking forward to it!`;
}
