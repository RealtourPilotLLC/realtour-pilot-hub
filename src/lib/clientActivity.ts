import "server-only";
import { prisma } from "@/lib/prisma";
import { etDateTime, etMonthDay, etMonthDayTime } from "@/lib/datetime";
import { isTestClientName } from "@/lib/testClients";
import { lastSentOf, messageOf, isOnboardingMessageKey, parseOnboardingRecord, ONBOARDING_RECORD_PREFIX, type OnboardingRecord } from "@/lib/clientOnboardingCore";
import { outboxKind, subjectFor } from "@/lib/outbox";
import { resolvePortalRoute } from "@/lib/portalNav";
import { PALETTE } from "@/lib/palette";
import { strategyGateFor, type StrategyGate } from "@/lib/strategyGate";

// ---------------------------------------------------------------------------
// CLIENT ACTIVITY (Jordan, Oct 14 2026): "Make sure I have an activity screen
// so I can track and see all of our clients' activity." The portal sign-up
// emails are about to go out, and the owner needs one place that answers
// "who has signed in, who is using it, and what is waiting on them".
//
// READ-ONLY, AND ONLY WHAT IS ALREADY RECORDED. Nothing new is tracked here;
// every line on the page comes from a ledger the portal already writes:
//   · PortalVisit (one row per portal render, STAFF visits excluded: those are
//     Jordan or Kyle looking through the owner preview, never the client);
//   · ClientMembership.invitedAt / acceptedAt, ClientUser.lastLoginAt;
//   · ClientDecision (a video approved or changes asked), PortalComment;
//   · ContentScriptRelease CLIENT_APPROVED / CLIENT_CHANGES (scriptDecisions);
//   · ContentTopicEvent with actorKind CLIENT (picked, removed, suggested);
//   · ContentInterview submissions; ContentMonth.planningChosenBy (route);
//   · ProgramMessage from the client; ProgramSessionRequest; ProgramCallBooking
//     and ProgramCallRecord; ClientBrandChange from the client portal;
//   · the onboarding record (AppSetting client-onboarding:<clientId>) and the
//     OutboxMessage rows that reached the client.
//
// WHAT IS NOT IN THOSE LEDGERS (and so not on the page) is listed in the
// report for this build: which portal section a visit opened (PortalVisit.path
// is the pathname only, "/portal/me" or "/portal/[token]"), each individual
// sign-in (only the first, acceptedAt, and the latest, lastLoginAt, are kept),
// a client opening a script or video without deciding, and a month brief
// upload (an AppSetting row with no actor column).
//
// WAITING ON THE CLIENT is not re-derived. It is the portal's own Home list
// (portalHome.homeActions) built from the same readers the portal page calls
// (portalTopics → planModel, libraryAttention, portalPlanning,
// portalMonthProgress + portalScheduleMonths → homeSessionView), so this page
// can never say something different from what the client is shown.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Page views by the same person this close together are one visit. */
export const VISIT_GAP_MS = 30 * 60_000;
/** A visit group may run this long past a page boundary and still be read whole. */
const GROUP_MARGIN_MS = 6 * 3600_000;
/** Raw page views read per feed page (the whole live table is ~4k rows). */
const RAW_VISIT_CAP = 5000;
/** Summary reads of the portal's own readers, at most this many clients at once. */
const WAITING_CONCURRENCY = 6;

// ---- health ------------------------------------------------------------------

export type HealthKey = "ACTIVE" | "QUIET" | "NEVER" | "NOT_INVITED";
export const HEALTH: Record<HealthKey, { label: string; hint: string; color: string }> = {
  ACTIVE: { label: "Active this week", hint: "visited or did something in the last 7 days", color: PALETTE.green },
  QUIET: { label: "Quiet 7+ days", hint: "has used the portal, nothing in the last 7 days", color: PALETTE.gold },
  NEVER: { label: "Never signed in", hint: "invited or emailed, never opened the portal", color: PALETTE.rose },
  NOT_INVITED: { label: "Not invited", hint: "no portal account and no welcome email yet", color: PALETTE.gray },
};
export const HEALTH_ORDER: HealthKey[] = ["ACTIVE", "QUIET", "NEVER", "NOT_INVITED"];
export const isHealthKey = (k: unknown): k is HealthKey => typeof k === "string" && (HEALTH_ORDER as string[]).includes(k);

export type AccountState = "NONE" | "INVITED" | "SIGNED_UP";

/** The one rule for the chip. Pure, so the drill reads the same rule the page does. */
export function healthOf(f: { account: AccountState; welcomeSentAt: Date | null; lastSeenAt: Date | null; visits7: number; actions7: number }): HealthKey {
  if (f.visits7 > 0 || f.actions7 > 0) return "ACTIVE";
  if (f.account === "SIGNED_UP" || f.lastSeenAt) return "QUIET";
  if (f.account === "INVITED" || f.welcomeSentAt) return "NEVER";
  return "NOT_INVITED";
}

// ---- paths -------------------------------------------------------------------

const SECTION_LABEL: Record<string, string> = {
  home: "Home", plan: "Your Month", library: "Content Library", schedule: "Schedule", more: "More",
  brand: "Brand Profile", messages: "Messages", resources: "Resources", team: "Settings & Team", terms: "Terms",
};

/** A recorded path that is an ACTION (a download, a posted mark), not a page view. */
export function pathAction(path: string): { kind: "DOWNLOAD" | "POSTED" | "UNPOSTED"; videoId: string } | null {
  const m = /^\/portal\/(download|posted)\/([a-z0-9]{10,40})(\?.*)?$/i.exec(path);
  if (!m) return null;
  if (m[1].toLowerCase() === "download") return { kind: "DOWNLOAD", videoId: m[2] };
  return { kind: /[?&]undo=1\b/.test(m[3] ?? "") ? "UNPOSTED" : "POSTED", videoId: m[2] };
}
export const isPageView = (path: string) => !pathAction(path);

/**
 * The portal section a recorded path names, when it names one. Today the
 * portal records the pathname only, so this is null for every live row; a
 * path that ever carries `?tab=` (or `pv=`) is read through the portal's own
 * route map, never a second list.
 */
export function sectionOfPath(path: string): string | null {
  const q = path.indexOf("?");
  if (q < 0) return null;
  const sp = new URLSearchParams(path.slice(q + 1));
  const tab = sp.get("tab");
  if (!tab && !sp.get("pv")) return null;
  const r = resolvePortalRoute({ tab: tab ?? "plan", pv: sp.get("pv") ?? undefined });
  return SECTION_LABEL[r.dest] ?? null;
}

// ---- collapse ----------------------------------------------------------------

export type RawVisit = { id: string; enrollmentId: string; clientUserId: string | null; via: string; path: string; createdAt: Date };
/**
 * `pages`: page views a person could have made, a reload inside RELOAD_MS of the
 * one before not counted again. `loads`: every recorded render. They differ a
 * lot only when something reloads the page by itself: on Oct 12 2026 one
 * shared link recorded 1,421 renders in 41 minutes, a median 0.2 s apart.
 */
export type VisitGroup = { key: string; enrollmentId: string; clientUserId: string | null; via: string; start: Date; end: Date; pages: number; loads: number; sections: string[] };

/** Renders closer together than this are one page view (a reload, a redirect, a double render). */
export const RELOAD_MS = 5_000;

/**
 * Consecutive page views by the same person (the same signed-in account, or
 * the shared link) on the same program, each within VISIT_GAP_MS of the one
 * before, are ONE visit. Input in any order; groups come back newest first.
 */
export function collapseVisits(visits: RawVisit[], gapMs = VISIT_GAP_MS): VisitGroup[] {
  const byPerson = new Map<string, RawVisit[]>();
  for (const v of visits) {
    const k = `${v.enrollmentId}|${v.clientUserId ?? "link"}`;
    const list = byPerson.get(k) ?? [];
    list.push(v);
    byPerson.set(k, list);
  }
  const out: VisitGroup[] = [];
  for (const [person, list] of byPerson) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    let cur: VisitGroup | null = null;
    for (const v of list) {
      if (cur && v.createdAt.getTime() - cur.end.getTime() <= gapMs) {
        if (v.createdAt.getTime() - cur.end.getTime() >= RELOAD_MS) cur.pages++;
        cur.end = v.createdAt;
        cur.loads++;
        if (v.via === "LOGIN") cur.via = "LOGIN";
      } else {
        cur = { key: `${person}|${v.id}`, enrollmentId: v.enrollmentId, clientUserId: v.clientUserId, via: v.via, start: v.createdAt, end: v.createdAt, pages: 1, loads: 1, sections: [] };
        out.push(cur);
      }
      const s = sectionOfPath(v.path);
      if (s && !cur.sections.includes(s)) cur.sections.push(s);
    }
  }
  return out.sort((a, b) => b.start.getTime() - a.start.getTime() || b.key.localeCompare(a.key));
}

// ---- words -------------------------------------------------------------------

export const clip = (s: string | null | undefined, n = 120): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const q = (s: string | null | undefined, fallback: string) => (s && s.trim() ? `“${clip(s, 80)}”` : fallback);
const monthName = (monthKey: string | null | undefined): string | null => {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstName = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] || null;

// ---- the feed ----------------------------------------------------------------

export type FeedKind = "visit" | "signin" | "action" | "system";
export type FeedItem = {
  id: string;
  at: Date;
  /** ET, e.g. "Tue, Oct 13, 9:02 AM". */
  atLabel: string;
  enrollmentId: string;
  clientId: string;
  clientName: string;
  /** The person, when we know one: a first name, "Shared link", or the office for a system line. */
  who: string | null;
  kind: FeedKind;
  text: string;
  detail: string | null;
  /** A client act that happened outside the portal (a Calendly booking): shown, never counted as portal use. */
  offPortal?: boolean;
};

type Scope = { enrollmentId: string; clientId: string; clientName: string };
type Draft = Omit<FeedItem, "atLabel" | "clientId" | "clientName"> & { clientId?: string };

type CollectOpts = {
  scopes: Scope[];
  /** exclusive upper bound */
  before: Date;
  /** inclusive lower bound (the summary's 7 days); none = paged by `take` */
  since?: Date | null;
  take: number;
  /** include system-to-client lines (the feed does; the action count does not need them) */
  system: boolean;
  /** include page-view groups and sign-ins */
  visits: boolean;
};

/**
 * Every client-side event in [since, before), newest first, from each ledger
 * at most `take` rows. One query per ledger for ALL the clients in scope,
 * plus one batched title lookup per kind of thing named.
 */
async function collect(o: CollectOpts): Promise<{ items: Draft[]; floor: Date | null }> {
  const eIds = o.scopes.map((s) => s.enrollmentId);
  const cIds = [...new Set(o.scopes.map((s) => s.clientId))];
  if (!eIds.length) return { items: [], floor: null };
  const range = { lt: o.before, ...(o.since ? { gte: o.since } : {}) };
  const take = o.take;
  const enrollmentOfClient = new Map(o.scopes.map((s) => [s.clientId, s.enrollmentId]));

  const [decisions, comments, releases, topicEvents, interviews, choices, messages, requests, callBookings, callRecords, brand, rawVisits, seats, outbox, onboarding] = await Promise.all([
    prisma.clientDecision.findMany({
      where: { enrollmentId: { in: eIds }, staffUserId: null, OR: [{ basis: null }, { basis: { notIn: ["AUTO_EXPIRY", "STAFF"] } }], decidedAt: range },
      orderBy: { decidedAt: "desc" }, take,
      select: { id: true, enrollmentId: true, clientUserId: true, actorLabel: true, decision: true, note: true, videoId: true, decidedAt: true },
    }),
    prisma.portalComment.findMany({
      where: { enrollmentId: { in: eIds }, staffUserId: null, createdAt: range },
      orderBy: { createdAt: "desc" }, take,
      select: { id: true, enrollmentId: true, clientUserId: true, body: true, timeSec: true, videoId: true, parentId: true, createdAt: true },
    }),
    prisma.contentScriptRelease.findMany({
      where: { enrollmentId: { in: eIds }, action: { in: o.system ? ["CLIENT_APPROVED", "CLIENT_CHANGES", "SHARE", "APPROVE_AND_SHARE"] : ["CLIENT_APPROVED", "CLIENT_CHANGES"] }, createdAt: range },
      orderBy: { createdAt: "desc" }, take,
      select: { id: true, enrollmentId: true, scriptId: true, action: true, actorClientUserId: true, actorAppUserId: true, note: true, createdAt: true },
    }),
    prisma.contentTopicEvent.findMany({
      where: { enrollmentId: { in: eIds }, actorKind: "CLIENT", createdAt: range },
      orderBy: { createdAt: "desc" }, take,
      select: { id: true, enrollmentId: true, topicId: true, kind: true, monthId: true, clientUserId: true, note: true, createdAt: true },
    }),
    prisma.contentInterview.findMany({
      where: { enrollmentId: { in: eIds }, staffUserId: null, submittedAt: range },
      orderBy: { submittedAt: "desc" }, take,
      select: { id: true, enrollmentId: true, topicId: true, monthId: true, submittedAt: true, submittedByClientUserId: true, sentWithGapsAt: true },
    }),
    prisma.contentMonth.findMany({
      where: { enrollmentId: { in: eIds }, OR: [{ planningChosenBy: { startsWith: "client:" } }, { planningChosenBy: "link" }], planningChosenAt: range },
      orderBy: { planningChosenAt: "desc" }, take,
      select: { id: true, enrollmentId: true, monthKey: true, planningMode: true, planningChosenAt: true, planningChosenBy: true },
    }),
    prisma.programMessage.findMany({
      where: { enrollmentId: { in: eIds }, ...(o.system ? {} : { authorKind: "CLIENT" }), createdAt: range },
      orderBy: { createdAt: "desc" }, take,
      select: { id: true, enrollmentId: true, authorKind: true, clientUserId: true, authorLabel: true, body: true, createdAt: true },
    }),
    prisma.programSessionRequest.findMany({
      where: { enrollmentId: { in: eIds }, requestedByStaffUserId: null, createdAt: range },
      orderBy: { createdAt: "desc" }, take,
      select: { id: true, enrollmentId: true, kind: true, slotStart: true, supersedesId: true, requestedByClientUserId: true, createdAt: true },
    }),
    prisma.programCallBooking.findMany({
      where: { enrollmentId: { in: eIds }, state: "CREATED", createdAt: range },
      orderBy: { createdAt: "desc" }, take,
      select: { id: true, enrollmentId: true, startAt: true, calendlyEventUri: true, createdAt: true },
    }),
    prisma.programCallRecord.findMany({
      where: { enrollmentId: { in: eIds }, callType: { in: ["MONTHLY_STRATEGY", "BRAND_DISCOVERY"] }, matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] }, createdAt: range },
      orderBy: { createdAt: "desc" }, take,
      select: { id: true, enrollmentId: true, clientUserId: true, callType: true, scheduledStart: true, calendlyEventUri: true, createdAt: true },
    }),
    prisma.clientBrandChange.findMany({
      where: { clientId: { in: cIds }, source: "client_portal", createdAt: range },
      orderBy: { createdAt: "desc" }, take,
      select: { id: true, clientId: true, enrollmentId: true, clientUserId: true, label: true, kind: true, createdAt: true },
    }),
    o.visits
      ? prisma.portalVisit.findMany({
          // A margin past `before`, so a visit that straddles the page boundary is read whole (see feed()).
          where: { enrollmentId: { in: eIds }, via: { not: "STAFF" }, createdAt: { lt: new Date(o.before.getTime() + GROUP_MARGIN_MS), ...(o.since ? { gte: new Date(o.since.getTime() - GROUP_MARGIN_MS) } : {}) } },
          orderBy: { createdAt: "desc" }, take: RAW_VISIT_CAP,
          select: { id: true, enrollmentId: true, clientUserId: true, via: true, path: true, createdAt: true },
        })
      : Promise.resolve([]),
    prisma.clientMembership.findMany({
      where: { enrollmentId: { in: eIds } },
      select: { clientUserId: true, enrollmentId: true, acceptedAt: true },
    }),
    o.system
      ? prisma.outboxMessage.findMany({
          where: {
            clientId: { in: cIds }, state: "accepted", createdAt: range,
            OR: ["portal_invite", "portal_login", "program_reminder", "script_share", "strategy_ready", "program_message", "onboarding", "welcome"].map((k) => ({ dedupeKey: { startsWith: `${k}:` } })),
          },
          orderBy: { createdAt: "desc" }, take,
          select: { id: true, clientId: true, channel: true, dedupeKey: true, acceptedAt: true, createdAt: true },
        })
      : // portal_login is the CLIENT asking for a sign-in link: read even without system lines.
        o.visits
        ? prisma.outboxMessage.findMany({
            where: { clientId: { in: cIds }, state: "accepted", dedupeKey: { startsWith: "portal_login:" }, createdAt: range },
            orderBy: { createdAt: "desc" }, take,
            select: { id: true, clientId: true, channel: true, dedupeKey: true, acceptedAt: true, createdAt: true },
          })
        : Promise.resolve([]),
    o.system
      ? prisma.appSetting.findMany({ where: { key: { in: cIds.map((c) => `${ONBOARDING_RECORD_PREFIX}${c}`) } }, select: { key: true, value: true } })
      : Promise.resolve([]),
  ]);

  // ---- names, in one read per kind ----
  const userIds = new Set<string>();
  for (const r of [...decisions, ...comments, ...topicEvents, ...messages]) if (r.clientUserId) userIds.add(r.clientUserId);
  for (const r of releases) if (r.actorClientUserId) userIds.add(r.actorClientUserId);
  for (const r of interviews) if (r.submittedByClientUserId) userIds.add(r.submittedByClientUserId);
  for (const r of requests) if (r.requestedByClientUserId) userIds.add(r.requestedByClientUserId);
  for (const r of [...brand, ...callRecords]) if (r.clientUserId) userIds.add(r.clientUserId);
  for (const r of [...rawVisits, ...seats]) if (r.clientUserId) userIds.add(r.clientUserId);
  for (const c of choices) if (c.planningChosenBy?.startsWith("client:")) userIds.add(c.planningChosenBy.slice(7));
  const pathVideoIds = rawVisits.map((v) => pathAction(v.path)?.videoId).filter((x): x is string => !!x);
  const videoIds = [...new Set([...decisions.map((d) => d.videoId), ...comments.map((c) => c.videoId), ...pathVideoIds].filter((x): x is string => !!x))];
  const topicIds = [...new Set([...topicEvents.map((e) => e.topicId), ...interviews.map((i) => i.topicId)])];
  const scriptIds = [...new Set(releases.map((r) => r.scriptId))];
  const monthIds = [...new Set(topicEvents.map((e) => e.monthId).filter((x): x is string => !!x))];
  const [users, videos, topics, scripts, months] = await Promise.all([
    userIds.size ? prisma.clientUser.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, lastLoginAt: true } }) : Promise.resolve([]),
    videoIds.length ? prisma.contentVideo.findMany({ where: { id: { in: videoIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    topicIds.length ? prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    scriptIds.length ? prisma.contentScript.findMany({ where: { id: { in: scriptIds } }, select: { id: true, title: true } }) : Promise.resolve([]),
    monthIds.length ? prisma.contentMonth.findMany({ where: { id: { in: monthIds } }, select: { id: true, monthKey: true } }) : Promise.resolve([]),
  ]);
  const userName = new Map(users.map((u) => [u.id, firstName(u.name)]));
  const person = (id: string | null | undefined, fallback: string | null = null) => (id ? userName.get(id) ?? "Their account" : fallback);
  const videoTitle = new Map(videos.map((v) => [v.id, v.title]));
  const topicTitle = new Map(topics.map((t) => [t.id, t.title]));
  const scriptTitle = new Map(scripts.map((s) => [s.id, s.title]));
  const monthKeyOf = new Map(months.map((m) => [m.id, m.monthKey]));
  const video = (id: string | null | undefined) => q(id ? videoTitle.get(id) : null, "a video");

  const items: Draft[] = [];
  const push = (d: Draft) => { if (d.at < o.before && (!o.since || d.at >= o.since)) items.push(d); };

  for (const d of decisions) {
    const changes = d.decision === "REQUEST_CHANGES";
    push({
      id: `decision:${d.id}`, at: d.decidedAt, enrollmentId: d.enrollmentId, who: person(d.clientUserId, "Shared link"), kind: "action",
      text: changes ? `Asked for changes on video ${video(d.videoId)}${d.note?.trim() ? `: ${clip(d.note)}` : ""}` : `Approved video ${video(d.videoId)}`,
      detail: null,
    });
  }
  for (const c of comments) {
    const t = c.timeSec != null ? ` at ${Math.floor(c.timeSec / 60)}:${String(Math.floor(c.timeSec % 60)).padStart(2, "0")}` : "";
    push({ id: `comment:${c.id}`, at: c.createdAt, enrollmentId: c.enrollmentId, who: person(c.clientUserId, "Shared link"), kind: "action", text: `${c.parentId ? "Replied to a note" : "Left a note"} on ${video(c.videoId)}${t}: ${clip(c.body)}`, detail: null });
  }
  for (const r of releases) {
    const title = q(scriptTitle.get(r.scriptId), "a script");
    if (r.action === "CLIENT_APPROVED") push({ id: `script:${r.id}`, at: r.createdAt, enrollmentId: r.enrollmentId, who: person(r.actorClientUserId, "Shared link"), kind: "action", text: `Approved the script ${title}`, detail: null });
    else if (r.action === "CLIENT_CHANGES") push({ id: `script:${r.id}`, at: r.createdAt, enrollmentId: r.enrollmentId, who: person(r.actorClientUserId, "Shared link"), kind: "action", text: `Asked for changes on the script ${title}${r.note?.trim() ? `: ${clip(r.note)}` : ""}`, detail: null });
    else push({ id: `script:${r.id}`, at: r.createdAt, enrollmentId: r.enrollmentId, who: null, kind: "system", text: `Script ${title} shared to their portal`, detail: null });
  }
  for (const e of topicEvents) {
    const title = q(topicTitle.get(e.topicId), "a topic");
    const month = monthName(e.monthId ? monthKeyOf.get(e.monthId) : null);
    const forMonth = month ? ` for ${month}` : "";
    const text =
      e.kind === "SELECTED" ? `Picked topic ${title}${forMonth}`
      : e.kind === "DESELECTED" ? `Removed topic ${title}${month ? ` from ${month}` : ""}`
      : e.kind === "DECLINED" ? `Said not interested to topic ${title}`
      : e.kind === "REINTRODUCED" ? `Put topic ${title} back in their bank`
      : e.kind === "CREATED" || e.kind === "SUGGESTED" ? `Suggested a topic: ${title}`
      : e.kind === "DISCUSSED" ? `Commented on topic ${title}${e.note?.trim() ? `: ${clip(e.note)}` : ""}`
      : `Updated topic ${title}`;
    push({ id: `topic:${e.id}`, at: e.createdAt, enrollmentId: e.enrollmentId, who: person(e.clientUserId, "Shared link"), kind: "action", text, detail: null });
  }
  for (const i of interviews) {
    if (!i.submittedAt) continue;
    push({ id: `answers:${i.id}`, at: i.submittedAt, enrollmentId: i.enrollmentId, who: person(i.submittedByClientUserId, "Shared link"), kind: "action", text: `Sent their answers for ${q(topicTitle.get(i.topicId), "a topic")}`, detail: i.sentWithGapsAt ? "Sent with some questions left open" : null });
  }
  for (const c of choices) {
    if (!c.planningChosenAt) continue;
    const month = monthName(c.monthKey) ?? "the month";
    const by = c.planningChosenBy?.startsWith("client:") ? c.planningChosenBy.slice(7) : null;
    const text = c.planningMode === "WRITTEN" ? `Chose to plan ${month} in writing` : c.planningMode === "CALL" ? `Chose a strategy call to plan ${month}` : `Changed how ${month} is planned`;
    push({ id: `route:${c.id}`, at: c.planningChosenAt, enrollmentId: c.enrollmentId, who: person(by, "Shared link"), kind: "action", text, detail: null });
  }
  for (const m of messages) {
    if (m.authorKind === "CLIENT") push({ id: `message:${m.id}`, at: m.createdAt, enrollmentId: m.enrollmentId, who: person(m.clientUserId, firstName(m.authorLabel)), kind: "action", text: `Sent a message: ${clip(m.body)}`, detail: null });
    else push({ id: `message:${m.id}`, at: m.createdAt, enrollmentId: m.enrollmentId, who: firstName(m.authorLabel), kind: "system", text: `${firstName(m.authorLabel) ?? "The office"} replied in Messages: ${clip(m.body)}`, detail: null });
  }
  for (const r of requests) {
    const day = r.slotStart ? etMonthDay(r.slotStart) : null;
    const what = r.kind === "EXTRA_SESSION" ? "an extra filming session" : "a filming session";
    const text = r.supersedesId
      ? `Asked to move a filming session${day ? ` to ${day}` : ""}`
      : day ? `Requested ${what} for ${day}` : `Asked for ${what} (times to agree)`;
    push({ id: `session:${r.id}`, at: r.createdAt, enrollmentId: r.enrollmentId, who: person(r.requestedByClientUserId, "Shared link"), kind: "action", text, detail: null });
  }
  const bookedUris = new Set(callBookings.map((b) => b.calendlyEventUri).filter(Boolean));
  for (const b of callBookings) {
    push({ id: `call:${b.id}`, at: b.createdAt, enrollmentId: b.enrollmentId, who: null, kind: "action", text: `Booked a strategy call for ${etMonthDayTime(b.startAt)}`, detail: null });
  }
  for (const r of callRecords) {
    if (r.calendlyEventUri && bookedUris.has(r.calendlyEventUri)) continue;
    const what = r.callType === "BRAND_DISCOVERY" ? "the discovery call" : "a strategy call";
    // Booked on Calendly, outside the portal: on the timeline, never counted as portal use.
    push({ id: `callrec:${r.id}`, at: r.createdAt, enrollmentId: r.enrollmentId!, who: person(r.clientUserId), kind: "action", text: `Booked ${what}${r.scheduledStart ? ` for ${etMonthDayTime(r.scheduledStart)}` : ""}`, detail: "through Calendly, outside the portal", offPortal: true });
  }
  for (const b of brand) {
    const eId = b.enrollmentId ?? enrollmentOfClient.get(b.clientId);
    if (!eId) continue;
    const text = b.kind === "FILE_ADDED" || b.kind === "FILE_REPLACED" ? `Added a file to their brand profile: ${clip(b.label, 60)}` : b.kind === "CLEARED" ? `Cleared ${clip(b.label, 60)} on their brand profile` : `Updated their brand profile: ${clip(b.label, 60)}`;
    push({ id: `brand:${b.id}`, at: b.createdAt, enrollmentId: eId, who: person(b.clientUserId), kind: "action", text, detail: null });
  }

  // ---- visits, downloads and sign-ins ----
  let floor: Date | null = null;
  if (o.visits) {
    const views = rawVisits.filter((v) => isPageView(v.path));
    let groups = collapseVisits(views);
    // The raw read hit its cap: the oldest group may be cut short. Drop it and
    // everything at or before its last page view; the next page re-reads it whole.
    if (rawVisits.length >= RAW_VISIT_CAP && groups.length) {
      const oldest = groups[groups.length - 1];
      floor = oldest.end;
      groups = groups.slice(0, -1);
    }
    for (const g of groups) {
      const who = g.clientUserId ? person(g.clientUserId) : "Shared link";
      const via = g.via === "TOKEN" ? "from the emailed link" : null;
      const text = g.pages === 1 ? (g.sections[0] ? `Opened ${g.sections[0]}` : "Opened the portal") : `Visited the portal (${plural(g.pages, "page")})`;
      const secs = Math.max(1, Math.round((g.end.getTime() - g.start.getTime()) / 1000));
      const span = secs < 60 ? `${secs} seconds` : `${Math.round(secs / 60)} min`;
      const reloads = g.loads - g.pages >= 10 ? `${g.loads} page loads in ${span}, most under ${RELOAD_MS / 1000} seconds apart (an automatic reload, not clicks)` : null;
      const detail = [g.pages > 1 && g.sections.length ? g.sections.join(", ") : null, via, reloads].filter(Boolean).join(" · ") || null;
      push({ id: `visit:${g.key}`, at: g.start, enrollmentId: g.enrollmentId, who, kind: "visit", text, detail });
    }
    for (const v of rawVisits) {
      const a = pathAction(v.path);
      if (!a) continue;
      const title = video(a.videoId);
      const text = a.kind === "DOWNLOAD" ? `Downloaded ${title}` : a.kind === "POSTED" ? `Marked ${title} as posted` : `Unmarked ${title} as posted`;
      push({ id: `path:${v.id}`, at: v.createdAt, enrollmentId: v.enrollmentId, who: v.clientUserId ? person(v.clientUserId) : "Shared link", kind: "action", text, detail: null });
    }
    const lastLogin = new Map(users.map((u) => [u.id, u.lastLoginAt]));
    for (const s of seats) {
      if (s.acceptedAt) push({ id: `firstin:${s.clientUserId}:${s.enrollmentId}`, at: s.acceptedAt, enrollmentId: s.enrollmentId, who: person(s.clientUserId), kind: "signin", text: "Signed in for the first time", detail: null });
      const last = lastLogin.get(s.clientUserId);
      // Only the latest sign-in is kept on the account (not each one).
      if (last && (!s.acceptedAt || last.getTime() - s.acceptedAt.getTime() > 60_000)) push({ id: `lastin:${s.clientUserId}:${s.enrollmentId}`, at: last, enrollmentId: s.enrollmentId, who: person(s.clientUserId), kind: "signin", text: "Signed in", detail: "their latest sign-in" });
    }
  }
  for (const m of outbox) {
    const eId = m.clientId ? enrollmentOfClient.get(m.clientId) : null;
    if (!eId) continue;
    const kind = outboxKind(m.dedupeKey);
    const atSent = m.acceptedAt ?? m.createdAt;
    if (kind === "portal_login") {
      push({ id: `outbox:${m.id}`, at: atSent, enrollmentId: eId, who: null, kind: "signin", text: "Asked for a sign-in link (emailed)", detail: null });
      continue;
    }
    const welcome = (kind === "portal_invite" && (m.dedupeKey ?? "").endsWith(":welcome")) || (kind === "onboarding" && (m.dedupeKey ?? "").startsWith("onboarding:welcome:"));
    const channel = m.channel === "sms" ? "Text" : "Email";
    const text = welcome ? "Welcome email sent" : kind === "portal_invite" ? "Portal invitation sent" : `${channel} sent: ${subjectFor(kind, m.dedupeKey)}`;
    push({ id: `outbox:${m.id}`, at: atSent, enrollmentId: eId, who: null, kind: "system", text, detail: null });
  }
  for (const row of onboarding) {
    const clientId = row.key.slice(ONBOARDING_RECORD_PREFIX.length);
    const eId = enrollmentOfClient.get(clientId);
    if (!eId) continue;
    const rec = parseOnboardingRecord(row.value);
    rec.log.forEach((e, i) => {
      // A hub send is already on the page as its outbox row; a "marked sent" (Jordan sent it himself) is not.
      if (!(e.kind === "marked" || (e.kind === "sent" && !e.outboxId)) || !e.message || !isOnboardingMessageKey(e.message)) return;
      const label = e.message === "welcome" ? "Welcome email" : `“${messageOf(e.message).label}”`;
      push({ id: `onboarding:${clientId}:${i}`, at: new Date(e.at), enrollmentId: eId, who: null, kind: "system", text: `${label} sent${e.kind === "marked" ? " by hand" : ""}`, detail: e.channel === "sms" ? "by text" : null });
    });
  }

  let out = items.filter((i) => Number.isFinite(i.at.getTime()));
  if (floor) out = out.filter((i) => i.at > floor!);
  out.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
  return { items: out, floor };
}

async function scopesFor(opts: { clientId?: string | null; includeTest?: boolean }): Promise<Scope[]> {
  const enrollments = await prisma.contentEnrollment.findMany({
    where: opts.clientId ? { clientId: opts.clientId } : { status: { in: ["ACTIVE", "PAUSED"] } },
    select: { id: true, clientId: true },
  });
  if (!enrollments.length) return [];
  const clients = await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  return enrollments
    .map((e) => ({ enrollmentId: e.id, clientId: e.clientId, clientName: nameOf.get(e.clientId) ?? "Client" }))
    .filter((s) => opts.clientId || opts.includeTest || !isTestClientName(s.clientName));
}

export type FeedPage = { items: FeedItem[]; nextBefore: string | null };

/**
 * The merged client timeline, newest first. `before` (an ISO time) pages back:
 * the next page starts strictly before the oldest line shown.
 */
export async function clientActivityFeed(opts: { clientId?: string | null; limit?: number; before?: Date | string | null; includeTest?: boolean; now?: Date } = {}): Promise<FeedPage> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const beforeRaw = opts.before ? new Date(opts.before) : null;
  const before = beforeRaw && Number.isFinite(beforeRaw.getTime()) ? beforeRaw : new Date((opts.now ?? new Date()).getTime() + 60_000);
  const scopes = await scopesFor({ clientId: opts.clientId, includeTest: opts.includeTest });
  const { items, floor } = await collect({ scopes, before, take: limit, system: true, visits: true });
  const byE = new Map(scopes.map((s) => [s.enrollmentId, s]));
  const page = items.slice(0, limit);
  // A full page may have more behind it (each ledger was read `limit` deep); a
  // capped visit read always does, from just after the group it left out.
  const nextBefore = page.length === limit ? page[limit - 1].at.toISOString() : floor ? new Date(floor.getTime() + 1).toISOString() : null;
  return {
    items: page.flatMap((d) => {
      const s = byE.get(d.enrollmentId);
      return s ? [{ ...d, clientId: s.clientId, clientName: s.clientName, atLabel: etDateTime(d.at) }] : [];
    }),
    nextBefore,
  };
}

// ---- the summary ---------------------------------------------------------------

export type WaitingKind = "REVIEW_VIDEOS" | "APPROVE_SCRIPTS" | "ANSWER_QUESTIONS" | "PICK_TOPICS" | "CHOOSE_ROUTE" | "BOOK_CALL" | "BOOK_SESSION" | "COMPLETE_ADDRESS" | "ADD_BRIEF" | "STRATEGY_PENDING";
export type WaitingItem = { kind: WaitingKind; count: number; label: string };
const WAITING_KINDS: readonly string[] = ["REVIEW_VIDEOS", "APPROVE_SCRIPTS", "ANSWER_QUESTIONS", "PICK_TOPICS", "CHOOSE_ROUTE", "BOOK_CALL", "BOOK_SESSION", "COMPLETE_ADDRESS", "ADD_BRIEF"];

/** Staff words for the portal's own Home actions. */
export function waitingLabel(kind: WaitingKind, count: number): string {
  switch (kind) {
    case "REVIEW_VIDEOS": return `${plural(count, "video")} to review`;
    case "APPROVE_SCRIPTS": return `${plural(count, "script")} to approve`;
    case "ANSWER_QUESTIONS": return `Questions to answer (${plural(count, "topic")})`;
    case "PICK_TOPICS": return `${plural(count, "topic")} to pick`;
    case "CHOOSE_ROUTE": return "Choose call or written planning";
    case "BOOK_CALL": return "Strategy call to book";
    case "BOOK_SESSION": return count > 1 ? `${count} filming sessions to book` : "Filming session to book";
    case "COMPLETE_ADDRESS": return `Filming address to add${count > 1 ? ` (${count})` : ""}`;
    case "ADD_BRIEF": return "Month brief to add (optional)";
    case "STRATEGY_PENDING": return "Waiting on strategy — no booking yet";
  }
}

/** Oct 21 2026 (strategyGate.ts): the booking asks a closed strategy gate takes away. */
const STRATEGY_GATED_KINDS: ReadonlySet<string> = new Set(["CHOOSE_ROUTE", "BOOK_CALL", "BOOK_SESSION", "ANSWER_QUESTIONS", "PICK_TOPICS"]);

/** The waiting line for a client with no strategy in their portal yet: the discovery call, then the strategy. */
function strategyPendingItem(g: StrategyGate): WaitingItem {
  const label = g.discovery === "booked" && g.discoveryAt
    ? `Waiting on strategy — discovery call ${etMonthDayTime(g.discoveryAt)}, no booking yet`
    : g.discovery === "needed" ? "Waiting on strategy — discovery call not booked yet, no booking yet" : waitingLabel("STRATEGY_PENDING", 1);
  return { kind: "STRATEGY_PENDING", count: 1, label };
}

export type ActivityRow = {
  enrollmentId: string;
  clientId: string;
  name: string;
  pkg: string;
  status: string;
  test: boolean;
  account: AccountState;
  /** Seats on the program: who, and whether they have signed in. */
  people: { name: string | null; signedUp: boolean }[];
  firstSignInAt: Date | null;
  welcomeSentAt: Date | null;
  lastSeenAt: Date | null;
  visits7: number;
  visits30: number;
  actions7: number;
  /** null = not read (`waiting: false`; the page streams it through waitingPromises) or could not be read. */
  waiting: WaitingItem[] | null;
  health: HealthKey;
};

export type ActivitySummary = { rows: ActivityRow[]; test: ActivityRow[]; counts: Record<HealthKey, number>; generatedAt: Date };

/**
 * What is waiting on each client, one promise per program, started now and at
 * most `concurrency` clients read at a time. The page streams each cell as its
 * promise settles (the portal readers take one to two seconds a client, so the
 * table must not wait for all of them). A paused program is read-only in the
 * portal and has nothing to start, so it is not read at all. A failed read is
 * null ("could not read"), never an empty list.
 */
export function waitingPromises(rows: { enrollmentId: string; clientId: string; status: string }[], now: Date = new Date(), concurrency = WAITING_CONCURRENCY): Map<string, Promise<WaitingItem[] | null>> {
  const queue: (() => void)[] = [];
  let running = 0;
  const slot = () => new Promise<void>((go) => { if (running < concurrency) { running++; go(); } else queue.push(() => { running++; go(); }); });
  const release = () => { running--; queue.shift()?.(); };
  const out = new Map<string, Promise<WaitingItem[] | null>>();
  for (const r of rows) {
    if (r.status !== "ACTIVE") { out.set(r.enrollmentId, Promise.resolve([])); continue; }
    out.set(r.enrollmentId, (async () => {
      await slot();
      try { return await waitingOnClient({ id: r.enrollmentId, clientId: r.clientId, status: r.status }, now); }
      catch (err) { console.error(`[client-activity] waiting read failed for ${r.enrollmentId}`, err); return null; }
      finally { release(); }
    })());
  }
  return out;
}

/**
 * What is waiting on the client right now, by the portal's own Home rule.
 * Read as an owner-level seat would see it: every permission, nothing read-only
 * unless the program is, no unread replies and no setup list (those are the
 * client's own housekeeping, not the program's next step).
 */
export async function waitingOnClient(enrollment: { id: string; clientId: string; status: string }, now: Date = new Date()): Promise<WaitingItem[]> {
  const { portalTopics, portalPlanning, portalScheduleMonths, portalMonthProgress, homeSessionView } = await import("@/lib/portal");
  const { libraryAttention } = await import("@/lib/contentVideos");
  const { planModel, homeActions } = await import("@/lib/portalHome");
  const { etMonthKey, monthLabel } = await import("@/lib/contentProgram");
  const monthKey = etMonthKey(now);
  const e = { id: enrollment.id, clientId: enrollment.clientId };
  const [topics, attention, planning, schedule, progress] = await Promise.all([
    portalTopics(e),
    libraryAttention(e),
    portalPlanning(e).catch(() => null),
    portalScheduleMonths(e).catch(() => null),
    portalMonthProgress(e, monthKey, { now }).catch(() => null),
  ]);
  const readOnly = enrollment.status !== "ACTIVE";
  const hp = planModel(topics, monthKey, now);
  const sched = schedule ? schedule.find((m) => m.monthKey === monthKey) ?? schedule[0] ?? null : null;
  const sv = homeSessionView(progress, sched, { canBook: true, readOnly });
  const filmedWork = !!progress && (progress.sessions.cards.some((s) => s.state === "FILMED") || progress.production.delivered > 0 || progress.production.approved > 0 || progress.production.awaitingYou > 0);
  const visibleSelected = hp.month ? topics.groups.flatMap((g) => g.topics).filter((t) => !t.declined && t.selection?.monthId === hp.month?.id).length : 0;
  let briefIn = false;
  if (planning?.clientPlanned) {
    const b = await import("@/lib/monthBrief").then((m) => m.monthBrief(planning.monthId)).catch(() => null);
    briefIn = !!b && (b.files.length > 0 || !!b.notes?.text.trim());
  }
  const actions = homeActions({
    status: enrollment.status, readOnly,
    perms: { session: true, suggest: true, request: true, approve: true, profile: true },
    review: { count: attention.needReview, single: null, soonestDeadlineLabel: null },
    scripts: hp.scripts.map((t) => ({ topicId: t.id, title: t.title })),
    unread: 0,
    planning: planning ? { planningMode: planning.planningMode, callStatus: planning.callStatus, noCallEligible: planning.noCallEligible } : null,
    clientPlanned: planning?.clientPlanned ? { briefIn, monthLabel: monthLabel(planning.monthKey) } : null,
    month: hp.month ? { monthKey: hp.month.monthKey, label: monthLabel(hp.month.monthKey), owed: hp.month.owed, selected: hp.month.selected } : null,
    filmingStarted: filmedWork,
    topicHistoryNeedsReview: filmedWork && !!hp.month && (hp.month.selected === 0 || visibleSelected < hp.month.selected),
    toAnswer: hp.toAnswer.map((t) => ({ title: t.title, missing: t.plan?.missing ?? 0 })),
    session: { offerBooking: sv.offerBooking, required: sv.required, missing: sv.missing, deferred: !!sched?.deferredAtISO },
    addressNeeded: sched?.sessions.filter((x) => x.addressNeeded).length ?? 0,
    lateSession: planning?.late ? { label: planning.late.label, open: planning.late.state === "TO_BOOK" && planning.late.scriptsReady, combined: planning.late.combine.combined } : null,
    setup: null,
    ready: { count: 0, withFile: false, single: null },
    linkVisitor: null,
  });
  const items: WaitingItem[] = [actions.primary, ...actions.more]
    .filter((a): a is NonNullable<typeof a> => !!a && WAITING_KINDS.includes(a.kind))
    .map((a) => ({ kind: a.kind as WaitingKind, count: a.count, label: waitingLabel(a.kind as WaitingKind, a.count) }));
  // Oct 21 2026: no strategy in the portal yet → nothing to plan or book; say what it waits on instead.
  const gate = await strategyGateFor(enrollment.id).catch(() => null);
  if (gate && !gate.open) return [...items.filter((w) => !STRATEGY_GATED_KINDS.has(w.kind)), strategyPendingItem(gate)];
  return items;
}

/**
 * One row per ACTIVE or PAUSED program client; TEST clients come back in
 * their own list. Batched: one read per ledger for every client. A VISIT is a
 * collapsed run of page views (collapseVisits), read from the last 30 days
 * only. `waiting: true` also reads what is waiting on each client (the page
 * streams that column instead, through waitingPromises).
 */
export async function clientActivitySummary(opts: { now?: Date; waiting?: boolean } = {}): Promise<ActivitySummary> {
  const now = opts.now ?? new Date();
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    select: { id: true, clientId: true, package: true, status: true },
  });
  const eIds = enrollments.map((e) => e.id);
  const cIds = enrollments.map((e) => e.clientId);
  const [clients, seats, views30, lastSeen, onboarding, welcomeSends] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: cIds } }, select: { id: true, name: true } }),
    prisma.clientMembership.findMany({ where: { enrollmentId: { in: eIds }, revokedAt: null }, select: { enrollmentId: true, clientUserId: true, acceptedAt: true } }),
    prisma.portalVisit.findMany({
      where: { enrollmentId: { in: eIds }, via: { not: "STAFF" }, createdAt: { gte: d30, lte: now }, NOT: [{ path: { startsWith: "/portal/download/" } }, { path: { startsWith: "/portal/posted/" } }] },
      orderBy: { createdAt: "desc" }, take: 20_000,
      select: { id: true, enrollmentId: true, clientUserId: true, via: true, path: true, createdAt: true },
    }),
    prisma.portalVisit.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: eIds }, via: { not: "STAFF" }, createdAt: { lte: now } }, _max: { createdAt: true } }),
    prisma.appSetting.findMany({ where: { key: { in: cIds.map((c) => `${ONBOARDING_RECORD_PREFIX}${c}`) } }, select: { key: true, value: true } }),
    prisma.outboxMessage.findMany({
      where: { clientId: { in: cIds }, state: "accepted", OR: [{ dedupeKey: { startsWith: "portal_invite:", endsWith: ":welcome" } }, { dedupeKey: { startsWith: "onboarding:welcome:" } }] },
      select: { clientId: true, acceptedAt: true, createdAt: true },
    }),
  ]);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const users = seats.length ? await prisma.clientUser.findMany({ where: { id: { in: [...new Set(seats.map((s) => s.clientUserId))] } }, select: { id: true, name: true, lastLoginAt: true } }) : [];
  const userOf = new Map(users.map((u) => [u.id, u]));
  const records = new Map<string, OnboardingRecord>(onboarding.map((r) => [r.key.slice(ONBOARDING_RECORD_PREFIX.length), parseOnboardingRecord(r.value)]));
  const c30 = new Map<string, number>();
  const c7 = new Map<string, number>();
  for (const g of collapseVisits(views30)) {
    c30.set(g.enrollmentId, (c30.get(g.enrollmentId) ?? 0) + 1);
    if (g.end >= d7) c7.set(g.enrollmentId, (c7.get(g.enrollmentId) ?? 0) + 1);
  }
  const seen = new Map(lastSeen.map((r) => [r.enrollmentId, r._max.createdAt]));

  // Client actions in the last 7 days, by the feed's own collector. A booking
  // made on Calendly is the client's act but not portal use, so it is not counted.
  const scopes = enrollments.map((e) => ({ enrollmentId: e.id, clientId: e.clientId, clientName: nameOf.get(e.clientId) ?? "Client" }));
  const { items: week } = await collect({ scopes, before: new Date(now.getTime() + 1), since: d7, take: 2000, system: false, visits: true });
  const actions7 = new Map<string, number>();
  for (const i of week) if (i.kind === "action" && !i.offPortal) actions7.set(i.enrollmentId, (actions7.get(i.enrollmentId) ?? 0) + 1);

  const promised = opts.waiting === false ? null : waitingPromises(enrollments.map((e) => ({ enrollmentId: e.id, clientId: e.clientId, status: e.status })), now);
  const waiting = promised ? await Promise.all(enrollments.map((e) => promised.get(e.id)!)) : enrollments.map(() => null);

  const rows: ActivityRow[] = enrollments.map((e, idx) => {
    const name = nameOf.get(e.clientId) ?? "Client";
    const mine = seats.filter((s) => s.enrollmentId === e.id);
    const accepted = mine.map((s) => s.acceptedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
    const account: AccountState = accepted.length ? "SIGNED_UP" : mine.length ? "INVITED" : "NONE";
    const rec = records.get(e.clientId);
    const logged = rec ? lastSentOf(rec, "welcome") : null;
    const sends = welcomeSends.filter((w) => w.clientId === e.clientId).map((w) => w.acceptedAt ?? w.createdAt);
    const welcomeSentAt = [logged ? new Date(logged.at) : null, ...sends].filter((d): d is Date => !!d && Number.isFinite(d.getTime())).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const logins = mine.map((s) => userOf.get(s.clientUserId)?.lastLoginAt ?? null);
    const lastSeenAt = [seen.get(e.id) ?? null, ...logins].filter((d): d is Date => !!d && d <= now).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const facts = { account, welcomeSentAt, lastSeenAt, visits7: c7.get(e.id) ?? 0, actions7: actions7.get(e.id) ?? 0 };
    return {
      enrollmentId: e.id, clientId: e.clientId, name, pkg: e.package, status: e.status, test: isTestClientName(name),
      account,
      people: mine.map((s) => ({ name: userOf.get(s.clientUserId)?.name ?? null, signedUp: !!s.acceptedAt })),
      firstSignInAt: accepted[0] ?? null,
      welcomeSentAt, lastSeenAt,
      visits7: facts.visits7, visits30: c30.get(e.id) ?? 0, actions7: facts.actions7,
      waiting: waiting[idx],
      health: healthOf(facts),
    };
  });
  const real = rows.filter((r) => !r.test);
  const counts = Object.fromEntries(HEALTH_ORDER.map((k) => [k, real.filter((r) => r.health === k).length])) as Record<HealthKey, number>;
  return { rows: real, test: rows.filter((r) => r.test), counts, generatedAt: now };
}

// ---- sorting (pure; the page's ?sort=) -----------------------------------------

export const SORTS = [
  { key: "seen", label: "Last seen (newest)" },
  { key: "seen_old", label: "Last seen (oldest)" },
  { key: "name", label: "Name" },
] as const;
export type SortKey = (typeof SORTS)[number]["key"];
export const isSortKey = (k: unknown): k is SortKey => typeof k === "string" && SORTS.some((s) => s.key === k);

export function sortRows(rows: ActivityRow[], sort: SortKey): ActivityRow[] {
  const t = (r: ActivityRow) => r.lastSeenAt?.getTime() ?? null;
  return [...rows].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    const ta = t(a), tb = t(b);
    // Never seen sorts last either way: "oldest" is about who went quiet.
    if (ta == null || tb == null) return ta == null && tb == null ? a.name.localeCompare(b.name) : ta == null ? 1 : -1;
    return sort === "seen" ? tb - ta : ta - tb;
  });
}
