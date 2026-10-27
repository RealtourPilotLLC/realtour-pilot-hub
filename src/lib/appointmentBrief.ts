// ---------------------------------------------------------------------------
// THE SHOOT BRIEF, AS FIELDS (Jordan, Oct 27 2026: "Shoot Briefs should be
// expanded and visible - and the info should be parsed and added to their own
// fields in a nice shoot brief view"). Aryeo writes every appointment's
// description in one consistent plain-text shape:
//
//   Customer:
//   Name: Mike Flatley
//   Email: … / Phone: … / Notes: n/a
//   Order Items Serviced By This Appointment:
//    - (1x) Social Influencer: 0-1,999 Sq. Ft.
//   Order Notes:
//   n/a
//   Order Questions:
//    - Lock Box / Door Code: 1923
//    - Special Instructions for the photographer (for this property only): …
//   Or View Full Order Details:
//   https://app.aryeo.com/admin/orders/…/edit
//   Capture Zillow 3D Home Tour:
//   https://www.zillow.com/3dtour/capture_order?…
//
// This reads it into fields for the job page's appointment card. Pure and
// client-safe (lib/shoot's parseShootBrief is server-only and keeps only the
// on-site fields). Aryeo's "n/a" blanks are dropped; a header the parser does
// not know keeps its lines under its own label, so nothing Aryeo adds is lost.
// ---------------------------------------------------------------------------

export type AppointmentBrief = {
  customer: { name: string | null; email: string | null; phone: string | null; notes: string | null };
  /** "Social Influencer (0-1,999 Sq. Ft.)", with "2× " in front when more than one */
  services: string[];
  orderNotes: string | null;
  presence: string | null;
  lockbox: string | null;
  access: string | null;
  special: string | null;
  flexible: string | null;
  /** only when they asked to be waitlisted for an earlier time */
  waitlist: string | null;
  squareFeet: string | null;
  /** order questions the parser has no field for */
  other: { label: string; value: string }[];
  links: { label: string; href: string }[];
};

/** Aryeo appointment descriptions mix newlines and light HTML. */
export function briefText(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/<\/(div|p|li|ul)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;|&apos;/gi, "’")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BLANK = /^(?:n\/?a|none|-+)\.?$/i;
const real = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t && !BLANK.test(t) ? t : null;
};
/** The booking line the hub writes into a session order's notes (lib/sessionBooking). */
const HUB_BOOKING_LINE = /^\s*hub-session:\S+/i;
const URL_RE = /https?:\/\/\S+/i;

type Section = { head: string; lines: string[] };

const KNOWN_HEAD = /^(Customer|Order Items Serviced By This Appointment|Order Notes|Order Questions|Or View Full Order Details|Capture Zillow 3D Home Tour)\s*:\s*$/i;
// Any other "Header:" line on its own (no value after the colon, not a list item).
const OTHER_HEAD = /^([A-Z][^:\n]{2,60}):\s*$/;

function sections(text: string): Section[] {
  const out: Section[] = [{ head: "", lines: [] }];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const head = line.trim().match(KNOWN_HEAD) ?? (/^\s*[-•]|^\s*(Name|Email|Phone|Notes)\s*:/i.test(line) ? null : line.trim().match(OTHER_HEAD));
    if (head) out.push({ head: head[1].trim(), lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

/** "- Key: value" items, with wrapped lines folded into the item above. */
function items(lines: string[]): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-•]\s+(.+?):\s*(.*)$/);
    if (m) out.push({ key: m[1].trim(), value: m[2].trim() });
    else if (line.trim() && out.length) out[out.length - 1].value = `${out[out.length - 1].value} ${line.trim()}`.trim();
  }
  return out;
}

/** Parse an appointment description into fields. Null when nothing parses (the card shows the text as it is). */
export function parseAppointmentBrief(raw: string | null | undefined): AppointmentBrief | null {
  const text = briefText(raw);
  if (!text) return null;
  const out: AppointmentBrief = {
    customer: { name: null, email: null, phone: null, notes: null },
    services: [], orderNotes: null, presence: null, lockbox: null, access: null, special: null,
    flexible: null, waitlist: null, squareFeet: null, other: [], links: [],
  };
  let parsed = false;
  for (const s of sections(text)) {
    const head = s.head.toLowerCase();
    const body = s.lines.map((l) => l.trim()).filter(Boolean);
    if (!head) {
      // Text above the first header (a hand-made appointment's own note) stays, as a note.
      const value = real(body.join("\n"));
      if (value) out.other.push({ label: "Note", value });
    } else if (head === "customer") {
      parsed = true;
      for (const l of body) {
        const m = l.match(/^(Name|Email|Phone|Notes)\s*:\s*(.*)$/i);
        if (m) out.customer[m[1].toLowerCase() as keyof AppointmentBrief["customer"]] = real(m[2]);
      }
    } else if (head.startsWith("order items serviced")) {
      parsed = true;
      for (const l of body) {
        const m = l.match(/^[-•]\s*(?:\((\d+)x\)\s*)?(.+)$/i);
        if (!m) continue;
        const [title, ...rest] = m[2].split(":");
        const size = rest.join(":").trim();
        const n = Number(m[1] ?? 1);
        out.services.push(`${n > 1 ? `${n}× ` : ""}${title.trim()}${size ? ` (${size})` : ""}`);
      }
    } else if (head === "order notes") {
      parsed = true;
      out.orderNotes = real(body.filter((l) => !HUB_BOOKING_LINE.test(l)).join("\n"));
    } else if (head === "order questions") {
      parsed = true;
      for (const { key, value } of items(s.lines)) {
        const v = real(value);
        if (!v) continue;
        if (/present at the appointment|seller be present/i.test(key)) out.presence = v;
        else if (/lock\s*box|door\s*code/i.test(key)) out.lockbox = v;
        else if (/access the property|additional information to access/i.test(key)) out.access = v;
        else if (/special instructions/i.test(key)) out.special = v;
        else if (/flexible/i.test(key)) out.flexible = v;
        else if (/waitlist/i.test(key)) out.waitlist = /^no\b/i.test(v) ? null : v;
        else if (/square\s*footage|sq\.?\s*ft/i.test(key)) out.squareFeet = /^\d[\d,]*$/.test(v) ? `${Number(v.replace(/,/g, "")).toLocaleString("en-US")} sq ft` : v;
        else out.other.push({ label: key.replace(/\s*\(for this property only\)/i, "").replace(/\?$/, ""), value: v });
      }
    } else if (head.startsWith("or view full order")) {
      parsed = true;
      const url = body.join(" ").match(URL_RE)?.[0];
      if (url) out.links.push({ label: "Open the order in Aryeo", href: url });
    } else if (head.startsWith("capture zillow")) {
      parsed = true;
      const url = body.join(" ").match(URL_RE)?.[0];
      if (url) out.links.push({ label: "Capture the Zillow 3D tour", href: url });
    } else {
      const value = real(body.join("\n"));
      if (!value) continue;
      parsed = true;
      const url = value.match(URL_RE)?.[0];
      if (url && value.trim() === url) out.links.push({ label: s.head, href: url });
      else out.other.push({ label: s.head, value });
    }
  }
  return parsed ? out : null;
}
