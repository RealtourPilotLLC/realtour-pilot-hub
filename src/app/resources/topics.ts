// ---------------------------------------------------------------------------
// RESOURCES AND SOPS, BY WHO USES THEM (Jordan, Oct 27 2026: "Resources and
// SOPs. It's fine. I feel like it could be organized a little better").
//
// The categories on a link or an SOP are free text typed over the years
// ("Scheduling & Booking", "On-Site / Shooting", "Tools"…), so the page grouped
// by whatever was typed. Each category now lands in one of a few plain topics,
// by who reaches for it; the typed category stays as a small label on the item.
// A category no rule knows lands in "Everything else", never dropped. Pure, so
// the drill reads the same rule the page does.
// ---------------------------------------------------------------------------

export type ResourceTopic = "office" | "field" | "editing" | "tools" | "other";

export const RESOURCE_TOPICS: { key: ResourceTopic; title: string; blurb: string }[] = [
  { key: "office", title: "Booking, clients and messages", blurb: "For the office: scheduling, client care, what to say and how to handle a problem." },
  { key: "field", title: "Shooting", blurb: "For photographers: before the shoot and on site." },
  { key: "editing", title: "Editing and delivery", blurb: "For editors and whoever sends the work: the house look and getting it to the client." },
  { key: "tools", title: "Tools and logins", blurb: "The outside apps the team works in." },
  { key: "other", title: "Everything else", blurb: "" },
];

/** Which topic a typed category belongs to. Order matters: "Editing & Delivery" is editing, "On-Site / Shooting" is field. */
export function resourceTopicOf(category: string | null | undefined): ResourceTopic {
  const c = (category ?? "").toLowerCase();
  if (/\btools?\b|login|software|apps?\b/.test(c)) return "tools";
  if (/shoot|on-site|onsite|capture|drone|field|photograph/.test(c)) return "field";
  if (/edit|deliver|brand|style|video|lut|preset/.test(c)) return "editing";
  if (/book|schedul|client|communicat|problem|sales|pric|fee|call|billing|message|text/.test(c)) return "office";
  return "other";
}

/** Every word of the search must appear somewhere in the item's text (case and spacing ignored). */
export function matchesSearch(haystack: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const h = haystack.toLowerCase();
  return words.every((w) => h.includes(w));
}
