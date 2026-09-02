import "server-only";
import { prisma } from "@/lib/prisma";
import { etDate } from "@/lib/datetime";
import { clip, stripMoneySentences, stripQuotedReply } from "@/lib/text";
import { synthesizeClientProfile, type ClientProfileEditing, type ClientProfileInsights } from "@/lib/integrations/ai";

// The client "working profile": a creative-safe synthesis of who a client is to
// work with, drawn from comms, creatives' shoot debriefs, revision history,
// feedback, and the manual notes on file. Built on demand + nightly; stored on
// the Client so the client page (and the future creatives portal) can show it.
//
// IT IS AUDIENCE-SCOPED (Sep 2 2026). The stored profile is the FULL picture —
// rapport, voice, working habits, shoot-day logistics — and that is what the
// owner and ops see. An EDITOR gets `editorView()` only: the editing block, the
// brand/style line, the revision picture, the order count and the segment.
// Jordan: "There is too much there… These are all things that are not relevant
// or necessary for the editor to know." The split is made when the profile is
// GENERATED (see synthesizeClientProfile), not by filtering strings at render.

// Comms the creative team may see: CREATIVE + ADMIN tier, never OWNER-only.
const COMM_ROLES = ["CREATIVE", "ADMIN"];

// Bumped when the stored shape changes. v2 = the `editing` block exists, so a
// v1 profile has no editor-safe bullets yet and the nightly sweep rebuilds it.
export const CLIENT_PROFILE_VERSION = 2;

export type ClientProfile = ClientProfileInsights & {
  v?: number; // stored shape version (absent = v1, pre-audience-scoping)
  segment?: string | null; // the client's segment at build time (chip on the card)
  stats: { totalOrders: number; revisions: number; inboundMsgs: number };
};

// What an EDITOR is allowed to see. Built by explicit whitelist, never by
// spreading the full profile, so a field added to ClientProfile later cannot
// leak into the editor's view by accident. `segment` and `stats` are the
// snapshot taken when the profile was built; the card renders liveProfileFacts()
// over the top of them so the numbers on screen are today's.
export type EditorClientProfile = {
  v: number;
  segment: string | null;
  stats: { totalOrders: number; revisions: number };
  editing: ClientProfileEditing;
  brandStyle: string;
  revisions: { summary: string; commonTypes: string[] };
};

// One client change request, as an editor should read it back.
export type RevisionAsk = { when: string; text: string; project: string | null };

export async function buildClientProfile(clientId: string): Promise<{ ok: boolean; error?: string }> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, company: true, segment: true, socialClient: true, socialPlan: true,
      clientPreferences: true, editingPreferences: true, generalNotes: true, brandColors: true,
      projects: {
        select: { id: true, title: true, status: true },
        orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take: 40,
      },
    },
  });
  if (!client) return { ok: false, error: "Client not found." };

  const projectIds = client.projects.map((p) => p.id);
  const nonCancelled = client.projects.filter((p) => p.status !== "CANCELLED");

  const [comms, activities, feedback, revisions, inboundMsgs] = await Promise.all([
    prisma.commLog.findMany({
      where: { clientId, minRole: { in: COMM_ROLES } },
      orderBy: { occurredAt: "desc" }, take: 40,
      select: { direction: true, contactName: true, body: true, occurredAt: true },
    }),
    projectIds.length
      ? prisma.activity.findMany({
          where: { projectId: { in: projectIds }, type: { in: ["NOTE", "FLAG", "SPECIAL_REQUEST"] } },
          orderBy: { createdAt: "desc" }, take: 30,
          select: { body: true },
        })
      : Promise.resolve([] as { body: string }[]),
    projectIds.length
      ? prisma.feedback.findMany({
          where: { projectId: { in: projectIds } },
          orderBy: { createdAt: "desc" }, take: 12,
          select: { rating: true, sentiment: true, body: true },
        })
      : Promise.resolve([] as { rating: number | null; sentiment: string | null; body: string }[]),
    prisma.smartTask.count({ where: { clientId, taskType: "revision", status: { not: "CANCELLED" } } }),
    prisma.commLog.count({ where: { clientId, direction: "in", minRole: { in: COMM_ROLES } } }),
  ]);

  const stats = { totalOrders: nonCancelled.length, revisions, inboundMsgs };

  const insights = await synthesizeClientProfile({
    name: client.name,
    company: client.company,
    segment: client.segment,
    socialPlan: client.socialClient ? (client.socialPlan ?? "yes") : null,
    stats,
    sampleOrders: nonCancelled.slice(0, 8).map((p) => p.title),
    notes: {
      preferences: client.clientPreferences,
      editing: client.editingPreferences,
      general: client.generalNotes,
      brandColors: client.brandColors,
    },
    comms: comms
      .reverse()
      .map((c) => ({ who: c.direction === "out" ? "Us" : c.contactName || client.name, when: etDate(c.occurredAt), text: c.body || "" })),
    activities: activities.map((a) => a.body),
    feedback: feedback.map((f) => ({ rating: f.rating, sentiment: f.sentiment, text: f.body })),
  });

  if (!insights) return { ok: false, error: "Could not synthesize a profile (AI not connected, or not enough to go on yet)." };

  // `segment` and the version ride along in the JSON so the profile card can
  // show the segment chip (and tell a v1 profile from a v2 one) without every
  // call site having to select and pass those columns.
  const profile: ClientProfile = { ...insights, v: CLIENT_PROFILE_VERSION, segment: client.segment ?? null, stats };
  await prisma.client.update({
    where: { id: clientId },
    data: {
      profileSummary: insights.summary || null,
      profileJson: JSON.stringify(profile),
      profileUpdatedAt: new Date(),
    },
  });
  return { ok: true };
}

// Nightly: rebuild a bounded batch of missing/stale profiles for real clients,
// so the creatives portal always has fresh context without a big one-time spend.
// Capped per run to keep AI cost predictable.
//
// PRE-v2 PROFILES GO FIRST. Every profile written before Sep 2 2026 has no
// `editing` block, which means an editor opening that client's job sees only the
// handful of fields that were always editor-safe. Those clients are the ones
// actually costing us something, so they jump the queue ahead of the merely
// old-but-complete ones.
const AGE_STALE_MS = 10 * 24 * 3600_000;
export async function refreshStaleClientProfiles(limit = 20): Promise<{ refreshed: number }> {
  const cap = Math.min(limit, 60);
  const real = { parentClientId: null, transactionCount: { gt: 0 } } as const;

  const preV2 = await prisma.client.findMany({
    where: {
      ...real,
      profileJson: { not: null },
      NOT: { profileJson: { contains: `"v":${CLIENT_PROFILE_VERSION}` } },
    },
    orderBy: [{ profileUpdatedAt: { sort: "asc", nulls: "first" } }],
    take: cap,
    select: { id: true },
  });

  const rest = preV2.length < cap
    ? await prisma.client.findMany({
        where: {
          ...real,
          id: { notIn: preV2.map((c) => c.id) },
          OR: [
            { profileUpdatedAt: null },
            { profileUpdatedAt: { lt: new Date(Date.now() - AGE_STALE_MS) } },
          ],
        },
        orderBy: [{ profileUpdatedAt: { sort: "asc", nulls: "first" } }],
        take: cap - preV2.length,
        select: { id: true },
      })
    : [];

  let refreshed = 0;
  for (const c of [...preV2, ...rest]) {
    try {
      const r = await buildClientProfile(c.id);
      if (r.ok) refreshed++;
    } catch {
      /* skip a single failure, keep going */
    }
  }
  return { refreshed };
}

export function parseClientProfile(json: string | null | undefined): ClientProfile | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as ClientProfile;
    if (!p || typeof p !== "object") return null;
    // Normalise the pre-v2 shape so every reader can assume `editing` exists.
    return {
      ...p,
      v: typeof p.v === "number" ? p.v : 1,
      editing: {
        summary: p.editing?.summary ?? "",
        prefs: p.editing?.prefs ?? [],
        customerNotes: p.editing?.customerNotes ?? [],
        dos: p.editing?.dos ?? [],
        donts: p.editing?.donts ?? [],
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LEGACY (v1) PROFILES → a real editing block, TODAY.
//
// Every profile on file the day the audience split shipped (215 of 215, probed
// Sep 2 2026) is the v1 shape: no `editing` block at all. Whitelisting only
// `editing.*` therefore handed John and Kim an empty card and dropped the one
// line that matters most — John Collins's "Always add his RE/MAX Main Line logo
// and personal contact information to any video deliverable."
//
// So when the stored profile predates the new shape we BUILD the editing block
// out of the legacy fields instead of returning an empty one. It is not a
// straight copy: `dos`, `donts`, `shootNotes` and `aboutThem` were written for
// the whole team, so each line is passed through the same audience rule the
// generator now applies — a line survives only if it says something about the
// finished video or its delivery, and never if it is about rapport, messaging,
// scheduling or shoot day. Everything else is dropped, not shown.
//
// This is a READ-side rescue, not a replacement for regeneration: a v1 profile
// has no `editing.customerNotes` written for an editor, only what can be
// salvaged from lines written for someone else.

// Says something that changes the cut or the delivery.
const EDIT_TOPIC =
  /\b(videos?|reels?|edits?|editing|cuts?|footage|clips?|photos?|photography|images?|pictures?|galler(?:y|ies)|deliver\w*|export|render\w*|logos?|watermarks?|brand(?:s|ing|ed)?(?!\s*-?\s*new)|end ?cards?|intros?|outros?|captions?|subtitles?|overlays?|on-?screen|titles?|fonts?|colou?rs?|music|songs?|tracks?|audio|sound|pacing|transitions?|b-?rolls?|voice ?overs?|aspect ratios?|vertical|9:16|16:9|thumbnails?|floor ?plans?|lot ?lines?|virtual\w*|twilight|sky|retouch\w*|crop\w*|blur\w*|straighten|hdr|aerials?|tours?|slideshows?|scripts?|spell\w*|misspell\w*|typos?|mls|compliance|disclaimer|instagram|tiktok|youtube|posts?|posting|social)\b/i;

// …but never these. Rapport, personality, how they talk, when they are free,
// and anything that happens before the footage exists. Checked FIRST: a line
// that trips this is dropped even if it also names a deliverable.
const NOT_FOR_EDITOR =
  /\b(shoot\w*|on ?site|arriv\w*|park\w*|lockbox|access|keys?|wardrobe|outfits?|on-? ?camera|schedul\w*|resched\w*|calendar|availab\w*|appointments?|book\w*|texts?|texting|texted|calls?|calling|called|phone|voicemail|e-?mails?|messag\w*|respond\w*|repl(?:y|ies|ied)|communicat\w*|check-? ?ins?|reach\w* out|follow\w* up|rapport|friendly|warmly|personable|personality|humou?r|joke[sd]?|laugh\w*|banter|conversation|small talk|complimentar\w*|faith|church|famil(?:y|ies)|kids|referrals?|relationship|trust\w*|appreciat\w*|patient|price\w*|pricing|fees?|invoices?|payments?|contracts?|weather|light\w*|driv(?:e|ing)|travel|meet\w*|visits?|offices?|walk ?through|prep\w*|declutter|hand-?hold\w*|oversight|introduce\w*|introduction|respons\w*|sign(?:s|ed|ing)? off|interactions?|effusiv\w*|enthusias\w*|mindset)\b/i;

// A standing instruction ("always add…", "never include…") rather than general
// advice — those are what `editing.prefs` is for.
const STANDING = /\b(always|never|make sure|ensure|be sure|must|standing|every (?:video|reel|cut|delivery|deliverable)|do not|don'?t)\b/i;

// A summary sentence only earns its place in the editor's block if it is
// telling the editor something, not narrating the relationship. Without this,
// "She has placed seven orders and never submitted a revision request" reads as
// an editing instruction because it contains the word "deliverables".
const SUMMARY_CUE =
  /\b(you|your|prefers?|prefer|wants?|likes?|dislikes?|expects?|requires?|insists?|asks? for|make sure|ensure|standing|must|always (?:add|include|use|put|keep|send)|never (?:add|include|use|put|show))\b/i;

function editorSafe(line: string): boolean {
  const s = (line ?? "").trim();
  if (s.length < 8) return false;
  if (NOT_FOR_EDITOR.test(s)) return false;
  return EDIT_TOPIC.test(s);
}

// Build the editing block a v1 profile never had. Deduped across the four
// lists so a line filed in two places is not read twice, and capped the same
// way the generator caps its own arrays.
function legacyEditing(p: ClientProfile): ClientProfileEditing {
  const seen = new Set<string>();
  const take = (lines: unknown, max = 6): string[] => {
    if (!Array.isArray(lines)) return [];
    const out: string[] = [];
    for (const raw of lines) {
      if (typeof raw !== "string" || !editorSafe(raw)) continue;
      const key = raw.trim().toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw.trim());
      if (out.length >= max) break;
    }
    return out;
  };

  // `dos` splits in two: the standing instructions are preferences ("always add
  // his logo"), the rest is advice ("deliver clean, natural edits").
  const dosAll = Array.isArray(p.dos) ? p.dos.filter((d): d is string => typeof d === "string" && editorSafe(d)) : [];
  const prefs = take([...dosAll.filter((d) => STANDING.test(d)), ...(Array.isArray(p.shootNotes) ? p.shootNotes : [])]);
  const dos = take(dosAll.filter((d) => !STANDING.test(d)));
  const donts = take(p.donts);
  const customerNotes = take(p.aboutThem, 4);

  const summary = (typeof p.summary === "string" ? p.summary : "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => editorSafe(s) && SUMMARY_CUE.test(s))
    .slice(0, 2)
    .join(" ");

  return { summary, prefs, customerNotes, dos, donts };
}

function hasEditingBlock(e: ClientProfileEditing | undefined): boolean {
  if (!e) return false;
  return Boolean(e.summary?.trim() || e.prefs?.length || e.customerNotes?.length || e.dos?.length || e.donts?.length);
}

// The EDITOR's slice of the profile. An explicit whitelist — nothing about
// rapport, personality, communication style, scheduling or shoot-day logistics
// crosses this line, and because the filter runs on the server the rest never
// reaches an editor's browser at all.
//
// A profile with no editing block (every pre-Sep-2 profile) is rescued by
// legacyEditing() above rather than rendering empty; brand/style, the revision
// picture and the counts were always editor-safe and pass through as they are.
export function editorView(profile: ClientProfile | null): EditorClientProfile | null {
  if (!profile) return null;
  const stored: ClientProfileEditing = {
    summary: profile.editing?.summary ?? "",
    prefs: profile.editing?.prefs ?? [],
    customerNotes: profile.editing?.customerNotes ?? [],
    dos: profile.editing?.dos ?? [],
    donts: profile.editing?.donts ?? [],
  };
  return {
    v: profile.v ?? 1,
    segment: profile.segment ?? null,
    stats: { totalOrders: profile.stats?.totalOrders ?? 0, revisions: profile.stats?.revisions ?? 0 },
    editing: hasEditingBlock(stored) ? stored : legacyEditing(profile),
    brandStyle: profile.brandStyle ?? "",
    revisions: {
      summary: profile.revisions?.summary ?? "",
      commonTypes: profile.revisions?.commonTypes ?? [],
    },
  };
}

// The counts and the segment shown on the profile card, read LIVE.
//
// The stored profile carries the numbers as they were the night it was built —
// Mike Ciunci's card said 34 orders while his own page header said 36, because
// the profile was two months old. Same for the segment: a client can cross into
// VIP long before their profile is next rebuilt. Everything on screen has to be
// true today, so the card reads these four straight from the source.
export type ProfileFacts = { segment: string | null; totalOrders: number; revisions: number; inboundMsgs: number };
export async function liveProfileFacts(clientId: string): Promise<ProfileFacts> {
  const [client, totalOrders, revisions, inboundMsgs] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { segment: true } }),
    prisma.project.count({ where: { clientId, status: { not: "CANCELLED" } } }),
    prisma.smartTask.count({ where: { clientId, taskType: "revision", status: { not: "CANCELLED" } } }),
    prisma.commLog.count({ where: { clientId, direction: "in", minRole: { in: COMM_ROLES } } }),
  ]);
  return { segment: client?.segment ?? null, totalOrders, revisions, inboundMsgs };
}

// The client's most recent change requests, read LIVE rather than baked into the
// profile — a revision asked this morning has to show up this morning, not after
// the next nightly rebuild. Prefers the analyzed work order (headline + first
// items) and falls back to the revision task itself. Money-scrubbed: this is a
// creative-facing surface.
export async function recentRevisionAsks(clientId: string, limit = 4): Promise<RevisionAsk[]> {
  const projects = await prisma.project.findMany({
    where: { clientId },
    orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 40,
    select: { id: true, title: true },
  });
  const titleById = new Map(projects.map((p) => [p.id, p.title]));
  const projectIds = projects.map((p) => p.id);

  const [briefs, tasks] = await Promise.all([
    projectIds.length
      ? prisma.revisionBrief.findMany({
          where: { projectId: { in: projectIds } },
          orderBy: { createdAt: "desc" },
          take: limit * 2,
          select: { createdAt: true, projectId: true, taskId: true, headline: true, itemsJson: true, originalText: true },
        })
      : Promise.resolve(
          [] as {
            createdAt: Date; projectId: string; taskId: string | null;
            headline: string | null; itemsJson: string | null; originalText: string;
          }[],
        ),
    prisma.smartTask.findMany({
      where: { clientId, taskType: "revision", status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      take: limit * 2,
      select: { id: true, createdAt: true, projectId: true, title: true, summary: true, description: true, propertyAddress: true },
    }),
  ]);

  const out: RevisionAsk[] = [];
  const seen = new Set<string>();
  const push = (when: Date, project: string | null, raw: string) => {
    const cleaned = askText(raw, project);
    // An "ask" that boiled down to nothing but the address (our own "Revision
    // request received — <property>" notification) is noise on this card: the
    // revision count above already says it happened.
    if (cleaned.length < 12) return;
    // …and neither is our own outbound mail, an account-support thread, or a
    // "no changes requested" verdict. This card says "here is what this client
    // asks you to change"; anything that is not that is worse than nothing.
    if (isOurOutbound(raw) || !looksLikeChangeAsk(cleaned)) return;
    const text = clip(cleaned, 220);
    const head = project?.split(",")[0]?.trim().toLowerCase() ?? "";
    if (head.length > 5 && text.toLowerCase().startsWith(head.slice(0, 18))) return;
    const key = text.toLowerCase().slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ when: etDate(when), text, project });
  };

  // A work order backfilled after the fact carries the date it was ANALYZED, not
  // the day the client asked. The revision task it belongs to has the real date.
  const askedOn = new Map(tasks.map((t) => [t.id, t.createdAt]));
  for (const b of briefs) {
    if (out.length >= limit) break;
    let line = b.headline?.trim() ?? "";
    if (!line && b.itemsJson) {
      try {
        const parsed = JSON.parse(b.itemsJson) as { items?: { ask?: string }[] };
        line = (parsed.items ?? []).map((i) => i.ask).filter(Boolean).slice(0, 2).join(" · ");
      } catch {
        /* an unparsable analysis just falls through to the raw ask */
      }
    }
    push((b.taskId ? askedOn.get(b.taskId) : null) ?? b.createdAt, titleById.get(b.projectId) ?? null, line || b.originalText || "");
  }
  // A task whose ask was already analyzed into a work order above must not come
  // back a second time in its raw form.
  const covered = new Set(briefs.map((b) => b.taskId).filter(Boolean) as string[]);
  for (const t of tasks) {
    if (out.length >= limit) break;
    if (covered.has(t.id)) continue;
    const project = (t.projectId ? titleById.get(t.projectId) : null) ?? t.propertyAddress ?? null;
    // `description` is the client's own words; `summary` wraps them in our
    // "Client asked for changes after delivery: “…” — confirm exactly what
    // needs to change…" boilerplate, so it is only the fallback.
    push(t.createdAt, project, t.description?.trim() || unwrapQuoted(t.summary) || t.title);
  }
  return out;
}

// The Gmail attribution line the client's mail app pastes UNDER their reply
// ("On Wed, Jul 1, 2026 at 8:34 AM … wrote:"). stripQuotedReply only catches it
// when it sits on one line; these arrive wrapped, so cut from it to the end.
const GMAIL_ATTRIBUTION = /\s+On\s+\w{3,9},?\s+\w{3,9}\s+\d{1,2},\s+\d{4}[\s\S]*$/;
// The subject line prepended to the body ("Re: Content delivery notification
// for 1033 Preserve Ln — Thanks for sending!…"). The client never said it, and
// it eats a third of the line the editor actually reads.
const SUBJECT_RE = /^(?:re|fwd|fw):\s*[^—\n]{0,140}—\s*/i;
const OUR_SUBJECT = /^[^—\n]{0,110}(?:delivery notification|revision request|edits?|photo question)[^—\n]{0,60}—\s*/i;

// Pull the client's words out of our own "…: “<their words>” — confirm…" wrapper.
function unwrapQuoted(s: string | null): string {
  if (!s) return "";
  const m = s.match(/^[^“"]{0,90}[“"]([\s\S]*?)[”"]\s*(?:—|$)/);
  return (m ? m[1] : s).trim();
}

// ---------------------------------------------------------------------------
// EMAIL SIGNATURE BLOCKS.
//
// Agents sign every mail, and the signature is longer than the ask: Gary Mercer
// Jr's three-line title block, two phone numbers, a website, four "[image:
// facebook] <https://…>" icon rows and a wire-fraud warning. stripQuotedReply
// only catches the RFC "-- " / "______" separators, so all of that was landing
// on an editor's card as if the client had asked for it — one live ask read
// "…so its primary bedroom directly to primary bathroom. Thx! *Gary Mercer Jr*
// *Realtor, Gary Mercer Team | LPT Realty* Preferred: (610) 812-6204…".
//
// Two passes, because signatures arrive both ways: line-shaped (an email body)
// and already flattened onto one line (a task description written earlier).

// Furniture: a line that is signature plumbing rather than something a person said.
const SIG_SEPARATOR = /^(?:-{2,}|_{2,}|—{2,}|\*{2,}|={3,})$/;
const SIG_LINE: RegExp[] = [
  /^[[(*]*\s*(?:image|photo|icon|cid|custom button app)\b/i, // "[image: facebook] <…>", "[photo]", "[icon] (570) 412-9274"
  /^<?(?:https?:\/\/|www\.)/i,
  /^.{0,60}<(?:tel|mailto|https?):/i,
  /^\**\s*(?:preferred|office|cell|direct|mobile|phone|main|fax|tel|toll)\b\s*:?\s*[<(]?\+?\d/i,
  /^\(?\+?\d[\d().\s-]{7,}\)?\s*(?:[|·,-]\s*)?(?:cell|office|direct|main(?: office)?|mobile|fax|c|o)?$/i, // "610-640-9300 Main Office"
  /^\**\s*(?:realtor|realtor®|broker|associate broker|listing coordinator|transaction coordinator|owner|coach|team lead|agent|licensed)\b/i,
  /^\**\s*[A-Z][\w.'’-]+(?:\s+[\w.'’-]+){0,3}\s*[-–|,]\s*(?:owner|realtor|broker|agent|coach|founder|ceo|president|photographer|coordinator|manager)\b/i, // "*Jordan Spackman - Owner*"
  /^\**\s*(?:re\/?max|keller williams|kw\b|coldwell|century 21|compass|berkshire|exp realty|lpt realty|long & foster|realty one|weichert|howard hanna)/i,
  // Case-SENSITIVE on purpose: "Brunner Group" is a signature, "please pass
  // this to the team" is a sentence.
  /^\**\s*[A-Z][A-Za-z.'&, -]{2,60}(?:LLC|L\.L\.C\.|Inc\.?|Group|Team|Realty|Realtors|Properties|Real Estate)\s*\**$/,
  /^\S+@\S+\.\w{2,}$/,
  /virus-?free|avast\.com/i,
  /^sent from my /i,
  /referrals are the greatest compliment|if you know of anyone looking to buy/i,
  /^\**\s*(?:warning|notice|confidentiality)\b[^\n]{0,40}e-?mail/i,
];
// A bare name line ("John Collins", "*Gary Mercer Jr*", "R. ASHLEY BRUNNER").
const SIG_NAME = /^\**\s*(?:[A-Z][A-Za-z.'’-]+|[A-Z]\.)(?:\s+(?:[A-Z][A-Za-z.'’-]+|[A-Z]\.|Jr\.?|Sr\.?|II|III))*\s*\**$/;
const SIGNOFF =
  /^[[(*]*\s*(?:thanks?(?: so much| again)?|thank you(?: so much)?|thx|many thanks|best|best regards|warm(?:est)? regards|kind regards|regards|sincerely|cheers|talk soon|all the best|respectfully)\s*[!.,]*\s*[\])*]*$/i;
// The same block flattened onto one line — cut from the earliest marker.
const SIG_INLINE: RegExp[] = [
  /\s*\**\s*(?:warning|notice|confidentiality)\b[^\n]{0,40}e-?mail (?:may not be|is|and any)/i,
  /\s*virus-?free\.?\s*www\./i,
  /\s*(?:if you know of anyone looking to buy|referrals are the greatest compliment)/i,
  /\s*\[(?:image|photo|icon|custom button app)\b/i,
  /\s*\S*<tel:/i,
  /\s*\*[A-Z][^*\n]{1,60}\*\s*\n?\s*\*?(?:realtor|broker|listing coordinator|transaction coordinator|owner|coach|agent)/i,
  /\s*\b(?:preferred|office|cell|direct|mobile|main office)\s*:\s*[<(]?\+?\d/i,
  /\s*\bphone:\s*[<(]?\+?\d/i,
];
// A sign-off left dangling at the very end once the block below it is gone.
const TRAILING_SIGNOFF =
  /[\s,]*\b(?:thanks?(?: so much| again)?|thank you(?: so much)?|thx|many thanks|best regards|best|warm(?:est)? regards|kind regards|regards|sincerely|cheers|talk soon|respectfully)\b[\s!.,]*$/i;

function stripSignature(body: string): string {
  const lines = body.split("\n");
  let end = lines.length;
  let dropped = false;
  while (end > 0) {
    const l = lines[end - 1].trim();
    if (!l) { end--; continue; }
    if (SIG_SEPARATOR.test(l) || SIG_LINE.some((re) => re.test(l))) { end--; dropped = true; continue; }
    if (SIGNOFF.test(l)) { end--; dropped = true; continue; }
    // A lone name is a signature — but only once something below it already
    // was, so a one-word answer ("Yes") is never mistaken for one.
    if (SIG_NAME.test(l) && (dropped || /^\*.+\*$/.test(l))) { end--; dropped = true; continue; }
    break;
  }
  let head = lines.slice(0, end).join("\n").trim();
  for (const re of SIG_INLINE) {
    const m = head.match(re);
    if (m && m.index !== undefined && m.index >= 12) head = head.slice(0, m.index).trim();
  }
  head = head.replace(TRAILING_SIGNOFF, "").trim();
  // Never strip an ask down to nothing: if the whole message looked like a
  // signature, the original is the safer thing to show.
  return head.length >= 12 ? head : body.trim();
}

// Our own outbound mail, quoted back into a revision task. "The photos have all
// been delivered … please let us know!" is a status update we sent, and on an
// editor's card it reads as a change the client wants. Tested on the sender's
// own words only, so a client quoting our delivery notification underneath
// their ask is unaffected.
const OUR_VOICE =
  /\brealtour\s?pilot llc\b|realtourpilot\.com|\bjordan spackman\b|\bwe(?:'|’)?re looking forward to sending\b|\bplease let us know if you need any (?:changes|adjustments)\b/i;
function isOurOutbound(raw: string): boolean {
  // Same two cuts askText makes: quoted history, then the wrapped "On <date> …
  // wrote:" attribution stripQuotedReply cannot see. Without the second cut the
  // client's own ask reads as ours the moment our reply is quoted underneath it.
  return OUR_VOICE.test(stripQuotedReply(raw).replace(GMAIL_ATTRIBUTION, ""));
}

// Is this plausibly a request to change something we made? A revision task can
// be opened off any thread that touched a delivered job — an Aryeo login
// problem, a receipt forwarded by mistake, an AI verdict of "no edit requests"
// — and none of those belong in front of an editor.
const NOT_AN_ASK =
  /\bno (?:client )?(?:edit|change|revision)s? (?:requests?|asks?)\b|\bno (?:edits?|changes?|revisions?) (?:found|needed|requested)\b|\bnothing to (?:change|fix)\b|\bstatus update thread\b|\b(?:technical|account)(?:\/(?:technical|account))? (?:support )?issue\b/i;
const TIMESTAMPED = /\[\s*\d{1,2}:\d{2}/; // "[1:06] More stabilization here" — a cut note, always an ask
// Verbs that are only ever said about work we delivered. "Can we take the TV
// and stand out?" and "there is a typo in the beginning" name no deliverable at
// all, and both are real asks, so these carry on their own.
const STRONG_ASK =
  /\b(typos?|misspell\w*|spelled|spelling|re-?edit\w*|revis(?:e|ed|ion)|retouch\w*|remov\w*|delet\w*|crop\w*|blur\w*|swap\w*|replac\w*|re-?cut|black out|take (?:it|them|that|this|the [\w ]{1,24}) ?out|leave (?:it|them|that) out|edit (?:out|it|this|that))\b/i;
const CHANGE_VERB =
  /\b(chang\w*|edit\w*|remov\w*|delet\w*|take out|took out|add\w*|replac\w*|swap\w*|fix\w*|correct\w*|updat\w*|redo|re-?do|adjust\w*|crop\w*|cut|cuts|trim\w*|blur\w*|brighten\w*|darken\w*|straighten\w*|retouch\w*|tweak\w*|revis\w*|shorten\w*|lengthen\w*|reorder\w*|mut(?:e|ed|ing)|misspell\w*|spelled|spelling|typos?|wrong|error|says?|should (?:say|be)|instead of|prefer\w*|don'?t want|do not want|can'?t show|cannot show|missing|not showing|doesn'?t show|leave out|include|match\w*|make (?:it|them|the|this|that|a)|use )\b/i;
const REQUEST_CUE =
  /\b(can you|could you|would you|can we|is there a way|any way|please|hoping|wondering|would love|want(?:ed|s)? (?:to|you|us)|need(?:ed|s)? (?:to|you|us)|ask(?:ing|ed)? (?:for|if))\b/i;
const MEDIA_NOUN =
  /\b(videos?|reels?|photo\w*|picture\w*|image\w*|clips?|footage|shots?|cut|cuts|edits?|floor ?plans?|tours?|galler(?:y|ies)|music|songs?|audio|sound|text|captions?|overlay|slides?|thumbnails?|logos?|intro|outro|drone|aerial|twilight|content|scenes?|background|titles?|scripts?)\b/i;

function looksLikeChangeAsk(text: string): boolean {
  if (NOT_AN_ASK.test(text)) return false;
  if (TIMESTAMPED.test(text) || STRONG_ASK.test(text)) return true;
  // Judged over the whole ask, not sentence by sentence: real requests split
  // the two halves across sentences all the time ("238 Hudson showcase photos —
  // Good morning! Can you please replace these?").
  return MEDIA_NOUN.test(text) && (CHANGE_VERB.test(text) || REQUEST_CUE.test(text));
}

// One revision ask, as an editor should read it: their words, without the mail
// plumbing or the signature block, money-scrubbed (this is a creative-facing
// surface). Returned unclipped so the relevance test above reads the whole ask.
function askText(raw: string, project: string | null): string {
  let t = stripQuotedReply(raw).replace(GMAIL_ATTRIBUTION, "");
  t = stripSignature(t);
  t = t.replace(SUBJECT_RE, "").replace(OUR_SUBJECT, "");
  // "1956 Wetherhill Drive — Hi, In the video…": the subject was the property,
  // which the card already shows on the line above.
  const head = project?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (head.length > 5) {
    const m = t.match(/^([^—\n]{0,90})—\s*/);
    if (m && m[1].trim().toLowerCase().startsWith(head.slice(0, 18))) t = t.slice(m[0].length);
  }
  return stripMoneySentences(t.replace(/\s+/g, " ")).trim();
}
