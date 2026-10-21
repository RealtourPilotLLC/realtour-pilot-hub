// ---------------------------------------------------------------------------
// BRANDED HTML EMAIL (Oct 21 2026). Pure: no prisma, no "server-only", so the
// outbox, a drill and a preview file all render the same thing.
//
// Jordan: "I want the emails to be formatted really nicely and branded in our
// colors, like our website. Is that possible?"
//
// HOW. Every client email is still WRITTEN as plain text (the templates, the
// welcome, the notes Jordan types), and that text still goes out as the
// text/plain half of the message, word for word. renderBrandedEmail turns the
// same text into the HTML half, so the two can never say different things:
//
//   · blank lines split paragraphs; a single newline is a line break;
//   · "• " / "- " lines are a bulleted list, "1. " lines a numbered one, and an
//     indented line under a list item continues it;
//   · a line that is only a link, or a line that ENDS with "…: <link>" (how
//     every template writes its main link), becomes an orange pill button,
//     labelled from the link and the words before it, with the plain link in
//     small type beneath for mail apps that block buttons;
//   · any other link is an orange inline link;
//   · the sign-off (the last short lines, "Jordan and the Realtour Pilot
//     team") stays text, set a little apart.
//
// THE LOOK, after realtourpilot.com: near-black #0a0a0a and white, accent
// orange #E96320 on bold pill buttons, Inter (with a safe fallback stack),
// heavy headings, a small uppercase orange eyebrow. Email-safe: tables and
// inline styles, 600px wide, a dark header band with the white wordmark, a
// white card on a soft light page, a dark footer band. `color-scheme` is
// declared and a dark palette is supplied, so a dark-mode mail app uses our
// dark colors instead of inverting the light ones into something unreadable.
//
// Nothing here ever reaches a client without its plain-text twin: the outbox
// sends both as multipart/alternative (multipartAlternative below).
// ---------------------------------------------------------------------------

export const EMAIL_BRAND = {
  ink: "#0a0a0a",
  accent: "#E96320",
  page: "#f3f3f1",
  card: "#ffffff",
  text: "#1f1f1f",
  muted: "#6b6b6b",
  logoUrl: "https://hub.realtourpilot.com/brand/wordmark-white.png",
  site: "https://realtourpilot.com",
  siteLabel: "realtourpilot.com",
  tagline: "Realtour Pilot · Pennsylvania's premier real estate media",
  font: "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
} as const;

const B = EMAIL_BRAND;
const DARK = { page: "#000000", card: "#141414", text: "#e8e8e8", heading: "#ffffff", muted: "#a3a3a3", link: "#ff8a4d" } as const;

/** Every character a client's words could use to break out of the markup. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
/** A link as written, minus punctuation that ends the sentence around it. */
function trimUrl(raw: string): { url: string; tail: string } {
  let url = raw;
  let tail = "";
  while (url.length > 8 && /[.,;:!?)\]}'"]$/.test(url)) {
    tail = url.slice(-1) + tail;
    url = url.slice(0, -1);
  }
  return { url, tail };
}

/**
 * The button's words, from the link and the words before it. Plain and
 * specific: "Open your portal" for the sign-in page, "Book your call" for a
 * booking page, otherwise "Open link".
 */
export function buttonLabelFor(url: string, before = ""): string {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return "Open link";
  }
  const ctx = before.toLowerCase();
  const aboutSession = /\bsession|\bfilming/.test(ctx) && !/\bcall\b/.test(ctx);
  if (host === "calendly.com" || host.endsWith(".calendly.com") || /\/(book|booking|schedule)(\/|$)/.test(path)) return aboutSession ? "Book your session" : "Book your call";
  if (/^\/portal\/login\/?$/.test(path)) return "Open your portal";
  if (/^\/portal\/address\//.test(path)) return "Add the address";
  if (/^\/portal(\/|$)/.test(path)) {
    // A portal page, or a sign-in link that lands on one: named for what the
    // email asks them to do there.
    if (/\bpick a time\b|\bbook\b/.test(ctx) && aboutSession) return "Book your session";
    if (/\breview\b/.test(ctx)) return "Review your videos";
    if (/\bstrategy\b/.test(ctx) && !/\bstrategy call\b/.test(ctx)) return "Read your strategy";
    if (/\bquestions?\b/.test(ctx)) return "Answer your questions";
    if (/\bscripts?\b/.test(ctx)) return "Read your scripts";
    return /^\/portal\/auth\//.test(path) ? "Sign in to your portal" : "Open your portal";
  }
  return "Open link";
}

// ---- the text, read into blocks --------------------------------------------

type Part = { kind: "text"; text: string } | { kind: "button"; url: string; label: string };
type Seg =
  | { kind: "p"; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: Part[][] }
  | { kind: "button"; url: string; label: string };

const BULLET = /^\s*[•-]\s+(\S.*)$/;
const NUMBERED = /^\s*(\d{1,2})[.)]\s+(\S.*)$/;
const URL_ONLY = /^\s*(https?:\/\/\S+)\s*$/i;
/** "…here: <link>" with the link ending the line. */
const TRAILING_URL = /^(.*\S:)\s+(https?:\/\/\S+)\s*$/i;
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^.!?]{0,60}[,!]?$/i;

const blocksOf = (text: string): string[][] =>
  text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((b) => b.split("\n").map((l) => l.replace(/\s+$/, "")))
    .map((b) => {
      while (b.length && !b[0].trim()) b.shift();
      while (b.length && !b[b.length - 1].trim()) b.pop();
      return b;
    })
    .filter((b) => b.length > 0);

/** Names a button from its link and the words around it. */
type Labeler = (url: string, words: string) => string;

/** One line inside a list item: text, a button, or text then a button. */
function partsOfLine(line: string, before: string, label: Labeler): Part[] {
  const only = URL_ONLY.exec(line);
  if (only) {
    const { url, tail } = trimUrl(only[1]);
    if (!tail) return [{ kind: "button", url, label: label(url, before) }];
  }
  const trail = TRAILING_URL.exec(line);
  if (trail) {
    const { url, tail } = trimUrl(trail[2]);
    if (!tail) return [{ kind: "text", text: trail[1].trim() }, { kind: "button", url, label: label(url, `${trail[1]} ${before}`) }];
  }
  return [{ kind: "text", text: line.trim() }];
}

const textOfParts = (parts: Part[]): string => parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ");

function segmentsOf(lines: string[], previous: string, label: Labeler): Seg[] {
  const segs: Seg[] = [];
  let para: { kind: "p"; lines: string[] } | null = null;
  let list: { kind: "list"; ordered: boolean; start: number; items: Part[][] } | null = null;
  // The words a button is labelled from: this paragraph's, and the block
  // before when this one is short ("Read them here:" under a list of scripts).
  const context = (own: string) => (own.length < 40 ? `${own} ${previous}` : own);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        list = { kind: "list", ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
        segs.push(list);
      }
      para = null;
      const body = bullet ? bullet[1] : numbered![2];
      list.items.push(partsOfLine(body, context(body), label));
      continue;
    }
    if (list && list.items.length && (/^\s{2,}\S/.test(raw) || URL_ONLY.test(line))) {
      // An indented line (or a lone link) under an item continues that item.
      const item = list.items[list.items.length - 1];
      item.push(...partsOfLine(line.trim(), context(textOfParts(item)), label));
      continue;
    }
    list = null;
    const only = URL_ONLY.exec(line);
    if (only && !trimUrl(only[1]).tail) {
      const { url } = trimUrl(only[1]);
      segs.push({ kind: "button", url, label: label(url, context(para ? para.lines.join(" ") : "")) });
      para = null;
      continue;
    }
    const trail = TRAILING_URL.exec(line);
    if (trail && !trimUrl(trail[2]).tail) {
      if (!para) {
        para = { kind: "p", lines: [] };
        segs.push(para);
      }
      para.lines.push(trail[1].trim());
      const url = trimUrl(trail[2]).url;
      segs.push({ kind: "button", url, label: label(url, context(para.lines.join(" "))) });
      para = null;
      continue;
    }
    if (!para) {
      para = { kind: "p", lines: [] };
      segs.push(para);
    }
    para.lines.push(line.trim());
  }
  return segs;
}

/** The last block is a sign-off when it is a few short lines with no link and no list. */
const HAS_URL = /https?:\/\//i;
function isSignOff(block: string[]): boolean {
  return block.length <= 3 && block.every((l) => l.trim().length > 0 && l.trim().length <= 70 && !HAS_URL.test(l) && !BULLET.test(l) && !NUMBERED.test(l));
}

/** The preview line under the subject in an inbox: the first sentence after the greeting. */
export function firstSentence(text: string): string {
  for (const block of blocksOf(text)) {
    const joined = block.map((l) => l.trim()).join(" ").trim();
    if (!joined || (block.length === 1 && GREETING.test(joined))) continue;
    if (block.every((l) => BULLET.test(l) || NUMBERED.test(l))) continue;
    const plain = joined.replace(URL_RE, "").replace(/\s+([.,:;!?])/g, "$1").replace(/\s+/g, " ").trim();
    const m = /^(.+?[.!?])(\s|$)/.exec(plain);
    const s = (m ? m[1] : plain).trim();
    if (!s) continue;
    return s.length > 140 ? `${s.slice(0, 137).replace(/\s+\S*$/, "")}...` : s;
  }
  return "";
}

/** The small orange label above the heading, from the subject. */
export function eyebrowFor(subject: string): string {
  const s = subject.toLowerCase();
  if (/sign-in|sign in/.test(s)) return "Sign in";
  if (/welcome/.test(s)) return "Welcome";
  if (/\bscripts?\b/.test(s)) return "Your scripts";
  if (/strategy/.test(s)) return "Your strategy";
  if (/\bvideos?\b/.test(s)) return "Your videos";
  if (/filming|session/.test(s)) return "Filming";
  if (/\breply\b|message/.test(s)) return "Messages";
  if (/logo|brand/.test(s)) return "Your brand";
  if (/content/.test(s)) return "Your content program";
  return "Realtour Pilot";
}

// ---- the markup --------------------------------------------------------------

const F = `font-family:${B.font};`;
const P_STYLE = `margin:0 0 18px;${F}font-size:16px;line-height:26px;color:${B.text};`;

function inline(text: string): string {
  let out = "";
  let last = 0;
  URL_RE.lastIndex = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    const { url, tail } = trimUrl(m[0]);
    out += escapeHtml(text.slice(last, at));
    out += `<a class="rtp-link" href="${escapeHtml(url)}" target="_blank" style="color:${B.accent};font-weight:600;text-decoration:underline;word-break:break-word;">${escapeHtml(url)}</a>`;
    out += escapeHtml(tail);
    last = at + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function buttonHtml(url: string, label: string, compact = false): string {
  const href = escapeHtml(url);
  const words = escapeHtml(label);
  const vmlWidth = Math.min(520, Math.max(200, label.length * 10 + 64));
  return [
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:${compact ? "10px 0 6px" : "4px 0 8px"};border-collapse:separate;">`,
    `<tr><td align="center" bgcolor="${B.accent}" style="border-radius:9999px;background-color:${B.accent};">`,
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:${vmlWidth}px;" arcsize="50%" stroke="f" fillcolor="${B.accent}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${words}</center></v:roundrect><![endif]-->`,
    `<!--[if !mso]><!--><a class="rtp-btn" href="${href}" target="_blank" style="display:inline-block;padding:15px 30px;${F}font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:9999px;background-color:${B.accent};">${words}</a><!--<![endif]-->`,
    `</td></tr></table>`,
    `<p class="rtp-muted" style="margin:0 0 ${compact ? "8px" : "20px"};${F}font-size:12px;line-height:18px;color:${B.muted};word-break:break-all;">Or open this link: <a class="rtp-muted" href="${href}" target="_blank" style="color:${B.muted};text-decoration:underline;">${escapeHtml(url)}</a></p>`,
  ].join("");
}

function partsHtml(parts: Part[]): string {
  let out = "";
  let text: string[] = [];
  const flush = () => {
    if (text.length) out += text.map(inline).join("<br>");
    text = [];
  };
  for (const p of parts) {
    if (p.kind === "text") text.push(p.text);
    else {
      flush();
      out += buttonHtml(p.url, p.label, true);
    }
  }
  flush();
  return out;
}

function segHtml(s: Seg): string {
  if (s.kind === "p") return `<p class="rtp-p" style="${P_STYLE}">${s.lines.map(inline).join("<br>")}</p>`;
  if (s.kind === "button") return buttonHtml(s.url, s.label);
  const tag = s.ordered ? "ol" : "ul";
  const start = s.ordered && s.start !== 1 ? ` start="${s.start}"` : "";
  const items = s.items.map((it) => `<li class="rtp-p" style="margin:0 0 10px;padding-left:4px;${F}font-size:16px;line-height:26px;color:${B.text};">${partsHtml(it)}</li>`).join("");
  return `<${tag} class="rtp-list"${start} style="margin:0 0 18px;padding:0 0 0 24px;">${items}</${tag}>`;
}

function signOffHtml(block: string[]): string {
  const [first, ...rest] = block.map((l) => l.trim());
  return [
    `<p class="rtp-p" style="margin:28px 0 0;${F}font-size:16px;line-height:24px;font-weight:700;color:${B.ink};">${inline(first)}</p>`,
    ...rest.map((l) => `<p class="rtp-muted" style="margin:4px 0 0;${F}font-size:14px;line-height:22px;color:${B.muted};">${inline(l)}</p>`),
  ].join("");
}

/** The body's HTML, from the plain text. The subject names a button whose own
 *  words say nothing about it ("Read them here:" in "Your scripts are ready"). */
export function brandedBodyHtml(text: string, subject = ""): string {
  const blocks = blocksOf(text);
  const signOff = blocks.length > 1 && isSignOff(blocks[blocks.length - 1]) ? blocks[blocks.length - 1] : null;
  const main = signOff ? blocks.slice(0, -1) : blocks;
  const label: Labeler = (url, words) => {
    const first = buttonLabelFor(url, words);
    return subject && (first === "Open your portal" || first === "Sign in to your portal") ? buttonLabelFor(url, subject) : first;
  };
  let previous = "";
  let out = "";
  for (const block of main) {
    const segs = segmentsOf(block, previous, label);
    out += segs.map(segHtml).join("");
    previous = block.map((l) => l.trim()).join(" ").replace(URL_RE, "").slice(0, 400);
  }
  if (signOff) out += signOffHtml(signOff);
  return out;
}

/**
 * The whole branded email. `text` is the message exactly as the plain-text
 * half carries it; `subject` is its heading; `preheader` (the inbox preview
 * line) defaults to the first sentence after the greeting.
 */
export function renderBrandedEmail(input: { subject: string; text: string; preheader?: string | null; eyebrow?: string | null }): string {
  const subject = (input.subject ?? "").trim() || "Realtour Pilot";
  const pre = (input.preheader ?? "").trim() || firstSentence(input.text ?? "");
  const eyebrow = (input.eyebrow ?? "").trim() || eyebrowFor(subject);
  // Spacers after the preheader keep the body's first words out of the preview line.
  const spacer = "&#8199;&#847;".repeat(60);
  const css = [
    ":root{color-scheme:light dark;supported-color-schemes:light dark;}",
    "body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}",
    "table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}",
    "img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}",
    `.rtp-list li::marker{color:${B.accent};font-weight:700;}`,
    "@media only screen and (max-width:620px){",
    ".rtp-outer{padding:0 !important;}",
    ".rtp-card{padding:30px 22px 28px !important;}",
    ".rtp-band{padding:22px 22px !important;}",
    ".rtp-h1{font-size:24px !important;line-height:30px !important;}",
    "}",
    "@media (prefers-color-scheme: dark){",
    `.rtp-page,.rtp-outer{background-color:${DARK.page} !important;}`,
    `.rtp-card{background-color:${DARK.card} !important;}`,
    `.rtp-h1{color:${DARK.heading} !important;}`,
    `.rtp-p,.rtp-p li{color:${DARK.text} !important;}`,
    `.rtp-muted,a.rtp-muted{color:${DARK.muted} !important;}`,
    `.rtp-link{color:${DARK.link} !important;}`,
    "}",
    // Outlook.com's dark mode marks what it changed; put our dark palette back.
    `[data-ogsc] .rtp-card{background-color:${DARK.card} !important;}`,
    `[data-ogsc] .rtp-h1{color:${DARK.heading} !important;}`,
    `[data-ogsc] .rtp-p{color:${DARK.text} !important;}`,
  ].join("\n");
  return [
    "<!doctype html>",
    `<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="X-UA-Compatible" content="IE=edge">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="supported-color-schemes" content="light dark">`,
    `<meta name="x-apple-disable-message-reformatting">`,
    `<title>${escapeHtml(subject)}</title>`,
    `<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->`,
    `<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"><!--<![endif]-->`,
    `<style>\n${css}\n</style>`,
    "</head>",
    `<body class="rtp-page" style="margin:0;padding:0;width:100%;background-color:${B.page};">`,
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${B.page};opacity:0;">${escapeHtml(pre)}${spacer}</div>`,
    `<table role="presentation" class="rtp-page" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="${B.page}" style="background-color:${B.page};">`,
    `<tr><td class="rtp-outer" align="center" style="padding:28px 12px;">`,
    `<!--[if mso]><table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->`,
    `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">`,
    // The dark header band and the white wordmark.
    `<tr><td class="rtp-band" bgcolor="${B.ink}" align="left" style="background-color:${B.ink};padding:28px 36px;border-radius:16px 16px 0 0;">`,
    `<a href="${B.site}" target="_blank" style="text-decoration:none;"><img src="${B.logoUrl}" width="180" alt="Realtour Pilot" style="display:block;width:180px;max-width:180px;height:auto;border:0;outline:none;color:#ffffff;${F}font-size:18px;font-weight:800;"></a>`,
    `</td></tr>`,
    `<tr><td height="4" bgcolor="${B.accent}" style="height:4px;line-height:4px;font-size:0;background-color:${B.accent};">&nbsp;</td></tr>`,
    // The card.
    `<tr><td class="rtp-card" bgcolor="${B.card}" align="left" style="background-color:${B.card};padding:40px 36px 36px;">`,
    `<p style="margin:0 0 10px;${F}font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${B.accent};">${escapeHtml(eyebrow)}</p>`,
    `<h1 class="rtp-h1" style="margin:0 0 26px;${F}font-size:28px;line-height:34px;font-weight:800;letter-spacing:-0.02em;color:${B.ink};">${escapeHtml(subject)}</h1>`,
    brandedBodyHtml(input.text ?? "", subject),
    `</td></tr>`,
    // The dark footer band.
    `<tr><td class="rtp-band" bgcolor="${B.ink}" align="left" style="background-color:${B.ink};padding:26px 36px;border-radius:0 0 16px 16px;">`,
    `<p style="margin:0;${F}font-size:13px;line-height:20px;font-weight:700;color:#ffffff;">${escapeHtml(B.tagline).replace("·", "&middot;")}</p>`,
    `<p style="margin:6px 0 0;${F}font-size:13px;line-height:20px;"><a href="${B.site}" target="_blank" style="color:${B.accent};font-weight:700;text-decoration:none;">${B.siteLabel}</a></p>`,
    `</td></tr>`,
    `</table>`,
    `<!--[if mso]></td></tr></table><![endif]-->`,
    `</td></tr>`,
    `</table>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}

// ---- the message: plain text and HTML, side by side -------------------------

/** A stable boundary from the content, so the same message builds the same bytes. */
function hash53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const base64Lines = (s: string): string => (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
/** Text in its canonical form (CRLF line ends) before encoding, as MIME asks. */
const crlf = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");

/**
 * The body of a multipart/alternative message: the plain text first (the
 * fallback), then the HTML (what a mail app shows when it can), both UTF-8 and
 * base64. The boundary carries "_", which base64 never does, so it can never
 * appear inside either part.
 */
export function multipartAlternative(p: { text: string; html: string }): { contentType: string; body: string; boundary: string } {
  const seed = `${p.text}\u0000${p.html}`;
  const boundary = `=_rtp_alt_${(hash53(seed, 1).toString(16).padStart(14, "0") + hash53(seed, 2).toString(16).padStart(14, "0")).slice(0, 24)}`;
  const part = (type: string, content: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", base64Lines(crlf(content))].join("\r\n");
  return {
    boundary,
    contentType: `multipart/alternative; boundary="${boundary}"`,
    body: [part("text/plain", p.text), part("text/html", p.html), `--${boundary}--`, ""].join("\r\n"),
  };
}

const headerOf = (head: string, name: string): string | null => {
  const re = new RegExp(`^${name}:[ \\t]*(.*(?:\\r\\n[ \\t].*)*)$`, "im");
  const m = re.exec(head);
  return m ? m[1].replace(/\r\n[ \t]+/g, " ").trim() : null;
};

function decodePart(body: string, encoding: string | null): string {
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc === "quoted-printable") {
    const bytes = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return body;
}

/**
 * Read one part back out of a raw message (drills, previews). A single-part
 * text/plain message answers its body as written; a multipart one answers the
 * decoded part, line ends back to "\n". null when the message has no such part.
 */
export function mimePartOf(mime: string, type: "text/plain" | "text/html"): string | null {
  const cut = mime.indexOf("\r\n\r\n");
  if (cut < 0) return type === "text/plain" ? mime : null;
  const head = mime.slice(0, cut);
  const body = mime.slice(cut + 4);
  const ct = headerOf(head, "Content-Type") ?? "text/plain";
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(ct)?.[1];
  if (!/^multipart\//i.test(ct) || !boundary) {
    if (!ct.toLowerCase().startsWith(type)) return null;
    const enc = headerOf(head, "Content-Transfer-Encoding");
    return enc ? decodePart(body, enc).replace(/\r\n/g, "\n") : body;
  }
  for (const chunk of body.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith("--")) break;
    const part = chunk.replace(/^\r\n/, "");
    const c = part.indexOf("\r\n\r\n");
    if (c < 0) continue;
    const ph = part.slice(0, c);
    if (!(headerOf(ph, "Content-Type") ?? "text/plain").toLowerCase().startsWith(type)) continue;
    return decodePart(part.slice(c + 4).replace(/\r\n$/, ""), headerOf(ph, "Content-Transfer-Encoding")).replace(/\r\n/g, "\n");
  }
  return null;
}

/** The plain-text words of a raw message, whichever shape it was sent in. */
export const plainTextOfMime = (mime: string): string => mimePartOf(mime, "text/plain") ?? "";
