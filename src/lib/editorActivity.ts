import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayStartUtc } from "@/lib/datetime";
import { editorMeta } from "@/lib/editors";
import { DESK_EDITOR_KEYS, workClock, type DeskItem, type WorkingNow } from "@/lib/editorWork";

// ---------------------------------------------------------------------------
// WHAT EACH EDITOR DID TODAY — as EVIDENCE, never as "working now" (Sep 28).
//
// Jordan, Sep 28: "It says Kim is not working on anything, but I believe he
// is!" He was right about Kim's day: three versions of 107 E Old Baltimore Pike
// uploaded that morning, and the Editing Room said "Kim — Not on anything"
// with nothing else on the page to weigh against it. It was right under §7.1
// too — Kim had never pressed Start — and that is the point of this file: the
// panel may not call Kim "working" off an upload (only the editor's own Start
// says that), but it must not hide what Kim DID either. So this reads the
// things an editor does with their own login and hands them back labelled as
// what they are: "Last action 12:14pm — uploaded a version of …".
//
// READ-ONLY. Nothing in here writes; a drill greps this file for write calls.
//
// WHAT COUNTS (each one an explicit action by the editor's own login):
//   E1 upload   ReviewSubmission source "upload" with the editor's key.
//               uploadAuthor writes a key on an upload only for an EDITOR
//               session — the office's uploads carry null — so the key IS the
//               person here, not a guess.
//   E2 sent     ReviewSubmission source "button" with the editor's key, whose
//               bound check was made by a login (actorUserId) and NOT on
//               anybody's behalf. The office sending for them stamps the
//               project's editor key on the row too, which is why the check's
//               onBehalfOf is the test and the row's key is not.
//   E3 check    CutSelfCheck by the editor's own login (onBehalfOf null,
//               actorUserId set, a real checklist — the hub's "none"
//               placeholder is not a person), minus the checks that are just
//               an E1/E2 row's own attestation.
//   E4 note     MediaNote authored "editor:<key>" (a reply when parentId).
//   E5 message  ProjectMessage whose authorId is the editor's TeamMember,
//               resolved with the SAME three rungs postProjectMessage uses to
//               stamp it (linked id → exact name → active roster email). Never
//               `contains`: "Mark" must not become John Mark.
//
// WHAT DOES NOT, on purpose (drill-asserted): opening a page or AutoRefresh;
// ThreadRead (reading a chat); the Dropbox folder sweep (source "folder");
// anything the office did on the editor's behalf; a note's "fixed" toggle
// (MediaNote/RevisionIssueEvent keep only a free-text name, not an identity);
// brief ticks (no actor recorded); Activity rows (free text); and Start/Pause
// themselves, which are STATE — lib/editorWork's workingNow answers that.
// Luma Visuals has no login, so nothing of theirs is ever evidence here.
//
// TODAY = since 12:00am Eastern, up to the read. Midnight resets it; paused
// work and the Start state are untouched by the window (they come from the
// work table, not from here).
// ---------------------------------------------------------------------------

export type ActivityKind = "upload" | "upload_started" | "upload_failed" | "sent" | "check" | "note" | "reply" | "message";

export type ActivityItem = {
  kind: ActivityKind;
  atISO: string;
  projectId: string;
  street: string;
  round: number | null;
  slot: number | null;
};

export type ActivityToday =
  | {
      ok: true;
      readAt: string;
      /** The window's start: 12:00am Eastern on the read's day. */
      since: string;
      editors: Record<string, { items: ActivityItem[] /* newest first, ≤20 */; startsToday: string[] }>;
    }
  | { ok: false; readAt: string; error: "Couldn't read today's activity." };

const MAX_ITEMS = 20;
const MAX_DETAIL_ITEMS = 8;

/** 12:00am Eastern on `now`'s day, to the whole second. etDayStartUtc carries
 *  `now`'s milliseconds into its answer (it derives the offset from `now`
 *  itself), so a read at 12:34:00.003 started the day at 04:00:00.003Z and an
 *  upload stamped exactly at midnight fell outside "today". Midnight Eastern
 *  is always a whole hour in UTC, so flooring to the second is exact. */
const dayStartOf = (now: Date) => new Date(Math.floor(etDayStartUtc(now).getTime() / 1000) * 1000);

const nameOf = (key: string) => editorMeta(key)?.name ?? key;
/** The queue's rule (editorQueue.toRow), so a street reads the same on the
 *  panel and on the row under it. */
const streetOf = (p: { addressLine: string | null; title: string }) => (p.addressLine || p.title.split(",")[0] || "Job").trim();

/**
 * Every ProjectMessage author id that is this editor, by the rungs
 * postProjectMessage used when it stamped the message: for each ACTIVE EDITOR
 * login carrying the key — its linked TeamMember; else the TeamMember whose
 * name equals the login's name (case-insensitive, exact); else the ACTIVE
 * TeamMember whose email equals the login's email.
 */
async function messageAuthorIds(keys: readonly string[]): Promise<Map<string, string>> {
  const users = await prisma.appUser.findMany({
    where: { role: "EDITOR", status: "ACTIVE", editorKey: { in: [...keys] } },
    select: { editorKey: true, teamMemberId: true, name: true, email: true },
  });
  const select = { id: true } as const;
  const owner = new Map<string, string>();
  const clash = new Set<string>();
  // Sequential on purpose: at most one login per editor, three rungs each.
  for (const u of users) {
    const myName = u.name?.trim();
    const tm =
      (u.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: u.teamMemberId }, select }) : null) ??
      (myName ? await prisma.teamMember.findFirst({ where: { name: { equals: myName, mode: "insensitive" } }, select }) : null) ??
      (u.email ? await prisma.teamMember.findFirst({ where: { email: { equals: u.email, mode: "insensitive" }, active: true }, select }) : null);
    if (!tm || !u.editorKey) continue;
    const had = owner.get(tm.id);
    // One roster row resolving to two editors is not an identity for either.
    if (had && had !== u.editorKey) clash.add(tm.id);
    else owner.set(tm.id, u.editorKey);
  }
  return new Map([...owner].filter(([id]) => !clash.has(id)));
}

/**
 * Today's explicit actions per desk editor (kim, john), newest first. Never
 * throws: a failed read comes back ok:false and the panel says it could not
 * read — it never turns into "Nothing in the hub today".
 */
export async function editorActivityToday(opts: { now?: Date } = {}): Promise<ActivityToday> {
  const now = opts.now ?? new Date();
  const readAt = now.toISOString();
  try {
    const keys = [...DESK_EDITOR_KEYS];
    const since = dayStartOf(now);
    const inWindow = { gte: since, lte: now };
    type Raw = Omit<ActivityItem, "street"> & { key: string };
    const raw: Raw[] = [];

    // E1 — the editor's own uploads.
    const uploads = await prisma.reviewSubmission.findMany({
      where: { source: "upload", submittedByKey: { in: keys }, createdAt: inWindow },
      select: { id: true, projectId: true, status: true, round: true, slot: true, submittedByKey: true, createdAt: true },
    });
    // E2 — the editor's own Dropbox "Send to Review", told apart from the
    // office's send by the bound check.
    const buttons = await prisma.reviewSubmission.findMany({
      where: { source: "button", submittedByKey: { in: keys }, createdAt: inWindow, selfCheckId: { not: null } },
      select: { id: true, projectId: true, round: true, slot: true, submittedByKey: true, createdAt: true, selfCheckId: true },
    });
    const buttonChecks = buttons.length
      ? await prisma.cutSelfCheck.findMany({
          where: { id: { in: buttons.map((b) => b.selfCheckId as string) } },
          select: { id: true, onBehalfOf: true, actorUserId: true },
        })
      : [];
    const ownCheck = new Set(buttonChecks.filter((c) => c.onBehalfOf === null && c.actorUserId !== null).map((c) => c.id));
    const sent = buttons.filter((b) => b.selfCheckId && ownCheck.has(b.selfCheckId));
    // Rows already counted, per editor — their own attestations are not a
    // second action.
    const counted = new Set<string>();
    for (const u of uploads) {
      const key = u.submittedByKey as string;
      counted.add(`${key}|${u.id}`);
      raw.push({
        key,
        kind: u.status === "UPLOADING" ? "upload_started" : u.status === "UPLOAD_FAILED" ? "upload_failed" : "upload",
        atISO: u.createdAt.toISOString(), projectId: u.projectId, round: u.round, slot: u.slot,
      });
    }
    for (const s of sent) {
      const key = s.submittedByKey as string;
      counted.add(`${key}|${s.id}`);
      raw.push({ key, kind: "sent", atISO: s.createdAt.toISOString(), projectId: s.projectId, round: s.round, slot: s.slot });
    }

    // E3 — a check the editor finished on a held cut.
    const checks = await prisma.cutSelfCheck.findMany({
      where: { editorKey: { in: keys }, onBehalfOf: null, actorUserId: { not: null }, checklistKey: { not: "none" }, createdAt: inWindow },
      select: { submissionId: true, projectId: true, round: true, slot: true, editorKey: true, createdAt: true },
    });
    for (const ch of checks) {
      const key = ch.editorKey as string;
      if (counted.has(`${key}|${ch.submissionId}`)) continue;
      raw.push({ key, kind: "check", atISO: ch.createdAt.toISOString(), projectId: ch.projectId, round: ch.round, slot: ch.slot });
    }

    // E4 — notes and replies under the editor's own author key.
    const notes = await prisma.mediaNote.findMany({
      where: { authorKey: { in: keys.map((k) => `editor:${k}`) }, createdAt: inWindow },
      select: { projectId: true, parentId: true, authorKey: true, createdAt: true },
    });
    for (const n of notes) {
      const key = (n.authorKey as string).slice("editor:".length);
      raw.push({ key, kind: n.parentId ? "reply" : "note", atISO: n.createdAt.toISOString(), projectId: n.projectId, round: null, slot: null });
    }

    // E5 — the job chat, by the editor's own roster row.
    const authors = await messageAuthorIds(keys);
    if (authors.size) {
      const msgs = await prisma.projectMessage.findMany({
        where: { authorId: { in: [...authors.keys()] }, createdAt: inWindow },
        select: { projectId: true, authorId: true, createdAt: true },
      });
      for (const m of msgs) {
        const key = authors.get(m.authorId as string);
        if (key) raw.push({ key, kind: "message", atISO: m.createdAt.toISOString(), projectId: m.projectId, round: null, slot: null });
      }
    }

    // Starts today — the editor's OWN presses only (the office's corrections
    // are the office's). Used for the tail's wording; never for state.
    const starts = await prisma.editorWorkEvent.findMany({
      where: { editorKey: { in: keys }, kind: { in: ["START", "RESUME", "CONFIRM"] }, actorRole: "EDITOR", onBehalf: false, at: inWindow },
      orderBy: { at: "desc" },
      select: { editorKey: true, at: true },
    });

    const projectIds = [...new Set(raw.map((r) => r.projectId))];
    const projects = projectIds.length
      ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, title: true, addressLine: true } })
      : [];
    const street = new Map(projects.map((p) => [p.id, streetOf(p)]));

    const editors: Record<string, { items: ActivityItem[]; startsToday: string[] }> = {};
    for (const k of keys) editors[k] = { items: [], startsToday: [] };
    for (const r of raw) {
      const s = street.get(r.projectId);
      // A job that is gone cannot be linked to; it is not evidence of anything
      // anybody can open.
      if (s === undefined || !editors[r.key]) continue;
      editors[r.key].items.push({ kind: r.kind, atISO: r.atISO, projectId: r.projectId, street: s, round: r.round, slot: r.slot });
    }
    for (const k of keys) {
      editors[k].items.sort((a, b) => b.atISO.localeCompare(a.atISO));
      editors[k].items = editors[k].items.slice(0, MAX_ITEMS);
    }
    for (const s of starts) if (editors[s.editorKey]) editors[s.editorKey].startsToday.push(s.at.toISOString());

    return { ok: true, readAt, since: since.toISOString(), editors };
  } catch (e) {
    console.error("[editorActivity] read failed", e);
    return { ok: false, readAt, error: "Couldn't read today's activity." };
  }
}

// ---- words ------------------------------------------------------------------

export type EditorLine = {
  key: string;
  name: string;
  tone: "on" | "paused" | "evidence" | "idle" | "unknown";
  lead: string;
  job: { street: string; href: string } | null;
  tail: string;
  /** [lead, job?.street, tail].filter(Boolean).join(" ") */
  text: string;
  details: string[];
};

export type EditorsTodayView = { ok: true; readAt: string; lines: EditorLine[] } | { ok: false; readAt: string; error: string };

const LEAD_WORDS: Record<ActivityKind, string> = {
  upload: "uploaded a version of",
  upload_started: "started uploading a version of",
  upload_failed: "tried to upload a version of",
  sent: "sent a version to review from",
  check: "did the review check on",
  note: "wrote a note on",
  reply: "replied to a note on",
  message: "posted in the chat on",
};

const ROW_WORDS: Record<ActivityKind, string> = {
  upload: "uploaded a version",
  upload_started: "started an upload",
  upload_failed: "tried to upload",
  sent: "sent a version",
  check: "did the review check",
  note: "wrote a note",
  reply: "replied to a note",
  message: "posted in chat",
};

const START_VERB: Record<string, string> = { START: "started", RESUME: "resumed", CONFIRM: "confirmed" };

const version = (round: number | null) => (round != null ? `v${round}` : "a version");

function detailOf(it: ActivityItem): string {
  switch (it.kind) {
    case "upload":
      return `uploaded ${version(it.round)}${it.slot != null && it.slot > 1 ? ` (video ${it.slot})` : ""} of ${it.street}`;
    case "upload_started":
      return `started uploading ${version(it.round)} of ${it.street}`;
    case "upload_failed":
      return `tried to upload ${version(it.round)} of ${it.street} — it didn't finish`;
    case "sent":
      return `sent ${version(it.round)} of ${it.street} to review from Dropbox`;
    default:
      return `${LEAD_WORDS[it.kind]} ${it.street}`;
  }
}

const line = (l: Omit<EditorLine, "text">): EditorLine => ({ ...l, text: [l.lead, l.job?.street, l.tail].filter(Boolean).join(" ") });

/**
 * One line per editor for the office's "Editors today" panel. PURE — the page
 * hands it the two reads and the read time; a drill hands it anything.
 *
 * The first rule that matches wins:
 *   1. ON        they pressed Start (or the office did, and the line says so)
 *   2. PAUSED    a pause today that is newer than anything they did after it
 *   3. EVIDENCE  no Start, but they did something today — shown as what it
 *                was, "Last action 12:14pm — uploaded a version of …"
 *   4. UNKNOWN   the activity read failed — never "Nothing in the hub today"
 *   5. IDLE      "Nothing in the hub today" — what the HUB saw, never a
 *                claim about the editor's day (Sep 28 review): cutting in
 *                Premiere or Dropbox leaves nothing here until a hand-in, and
 *                "No activity today" said Kim did nothing while he may have
 *                been editing all morning — Jordan's complaint, louder.
 *
 * §7.1: only an ON line may begin "On " or use the words working / active /
 * In editing. Evidence says "Last action", not "Last active" — the board's
 * "Active — Kim since …" already means Start.
 */
export function editorLines(wn: WorkingNow, act: ActivityToday, now: Date): EditorsTodayView {
  if (!wn.ok) return { ok: false, readAt: wn.readAt, error: wn.error };
  const t = (iso: string | null | undefined) => workClock(iso, now);
  const dayStart = act.ok ? act.since : dayStartOf(now).toISOString();
  const lines = wn.editors.map((e): EditorLine => {
    const mine = act.ok ? act.editors[e.key] : undefined;
    const items = mine?.items ?? [];
    const startsToday = mine?.startsToday ?? [];
    const href = (projectId: string) => `/edit/${projectId}`;

    const details: string[] = [];
    if (e.active?.firstStartedISO && e.active.firstStartedISO !== e.active.sinceISO) details.push(`First started ${t(e.active.firstStartedISO)}`);
    for (const it of items.slice(0, MAX_DETAIL_ITEMS)) details.push(`${t(it.atISO)} ${detailOf(it)}`);
    const pausedDetails = (skip: string | null) =>
      e.paused
        .filter((p: DeskItem) => p.projectId !== skip)
        .map((p) => `Paused: ${p.street} — ${t(p.sinceISO)}${p.onBehalfBy ? ` (by ${p.onBehalfBy}, office)` : ""}`);
    const claimDetails = e.unconfirmed.map(
      (c) => `Marked “In editing” before the Start button, not confirmed: ${c.street}${c.claimedAt ? ` (${t(c.claimedAt)})` : ""}`,
    );

    // 1 · ON
    if (e.active) {
      const a = e.active;
      const verb = START_VERB[a.lastEventKind ?? ""] ?? "started";
      const tail =
        `${a.outputTitle ? `· ${a.outputTitle} ` : ""}${a.sinceISO ? `since ${t(a.sinceISO)}` : ""}${a.onBehalfBy ? ` · ${verb} by ${a.onBehalfBy} (office)` : ""}`.trim();
      return line({
        key: e.key, name: e.name, tone: "on", lead: "On", job: { street: a.street, href: href(a.projectId) }, tail,
        details: [...details, ...pausedDetails(null), ...claimDetails],
      });
    }

    // 2 · PAUSED today, and nothing they did since
    const p = e.paused[0];
    if (p?.sinceISO && p.sinceISO >= dayStart && (!act.ok || !items[0] || p.sinceISO > items[0].atISO)) {
      return line({
        key: e.key, name: e.name, tone: "paused", lead: "Paused", job: { street: p.street, href: href(p.projectId) },
        tail: `at ${t(p.sinceISO)}${p.onBehalfBy ? ` · by ${p.onBehalfBy} (office)` : ""}`,
        details: [...details, ...pausedDetails(p.projectId), ...claimDetails],
      });
    }

    // 3 · EVIDENCE — what they did, labelled as that
    if (act.ok && items[0]) {
      const last = items[0];
      // "since" only when it is true: a Start pressed AFTER the last action
      // (and since closed by somebody else) is named instead of denied.
      const laterStart = startsToday.find((s) => s > last.atISO);
      const tail = laterStart
        ? `· last pressed Start ${t(laterStart)}`
        : startsToday.length ? "· hasn't pressed Start since" : "· hasn't pressed Start today";
      return line({
        key: e.key, name: e.name, tone: "evidence",
        lead: `Last action ${t(last.atISO)} — ${LEAD_WORDS[last.kind]}`,
        job: { street: last.street, href: href(last.projectId) }, tail,
        details: [...details, ...pausedDetails(null), ...claimDetails],
      });
    }

    // 4 · UNKNOWN — the activity read failed
    if (!act.ok) {
      return line({
        key: e.key, name: e.name, tone: "unknown", lead: "Not on anything · couldn't read today's activity", job: null, tail: "",
        details: [...details, ...pausedDetails(null), ...claimDetails],
      });
    }

    // 5 · IDLE — what the hub recorded, said as that. An editor the activity
    // read does not cover (a departed one still holding paused work) is not
    // claimed to have done nothing.
    return line({
      key: e.key, name: e.name, tone: "idle", lead: mine ? "Nothing in the hub today" : "Not on anything", job: null, tail: "",
      details: [...details, ...pausedDetails(null), ...claimDetails],
    });
  });
  return { ok: true, readAt: wn.readAt, lines };
}

/**
 * The backlog row's evidence line: the newest thing done on THIS job today by
 * an editor who is not on it right now (an active editor's row already wears
 * their Start chip). Null when nothing, or when the read failed.
 */
export function rowEvidence(
  row: { id: string; work: { active: { key: string }[] } },
  act: ActivityToday,
  now: Date,
): { name: string; words: string; at: string } | null {
  if (!act.ok) return null;
  const onIt = new Set(row.work.active.map((a) => a.key));
  let best: { key: string; it: ActivityItem } | null = null;
  for (const [key, ed] of Object.entries(act.editors)) {
    if (onIt.has(key)) continue;
    const it = ed.items.find((x) => x.projectId === row.id);
    if (it && (!best || it.atISO > best.it.atISO)) best = { key, it };
  }
  if (!best) return null;
  return { name: nameOf(best.key), words: ROW_WORDS[best.it.kind], at: workClock(best.it.atISO, now) };
}
