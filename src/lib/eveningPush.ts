import "server-only";
import { prisma } from "@/lib/prisma";
import { etAt, etDate, etDateTime, etDayKey, etHour } from "@/lib/datetime";
import { noDashes, scrubMoney } from "@/lib/text";
import type { OpsDay, OpsShoot } from "@/lib/opsDay";
import type { DeliveryBoard, BoardJob } from "@/lib/deliveryBoard";

// ---------------------------------------------------------------------------
// THE 6 PM WRAP AND THE NIGHT-BEFORE SHOOT BRIEFS (Oct 14 2026 comms audit).
//
// JORDAN'S 6 PM WRAP. Kyle's 5:30 Daily Closeout already computes most of an
// end-of-day summary (Home's closeoutRows over opsDay.buildOpsDay's
// `closeout`), and nothing pushed it to Jordan, who asked "did it go out?"
// about four times a week. Monday to Saturday at 6 PM ET, ONE Slack DM to the
// OWNER login's roster row and a copy to Kyle (the delivery duty owner), built
// from the SAME reads Home renders (buildOpsDay + deliveryBoard), not a second
// computation:
//   delivered today · due by 9 AM tomorrow and not out (with its stage) ·
//   late and who owns it · Kyle's open asks to Jordan and the cuts / photo
//   decisions waiting on him · Jordan's asks to Kyle open 3+ days ·
//   unanswered clients · tomorrow's gaps.
// Under 15 lines, plain words, no dashes. notifyStaffSms holds Jordan's copy
// inside his own quiet time (Saturday until 7:30 PM, notifySchedule.holdFor),
// so Saturday's lands at 7:30. One AppSetting claim per ET day.
//
// THE NIGHT-BEFORE SHOOT BRIEF. Photographers rarely open /shoot, and the only
// scheduled texts they get come after the shoot (uploadDigest.ts). From 6 PM
// ET, every day, each of tomorrow's shoots (Ops Day's own tomorrow list) gets
// ONE message to its assigned photographer by notifyStaffSms: time and
// address, what was ordered, access and client notes (Aryeo's order questions
// plus every SPECIAL_REQUEST line, which is where a texted gate code now
// lands, shootNotes.ts), and the photo target (culling.photoPolicyFor). A
// shoot with no access answer on file opens ONE task for Kyle. One claim per
// shoot per shoot day. Behind its own switch, default on. Staff only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const HOUR = 3_600_000;
const PUSH_FROM = 18;
const PUSH_TO = 20; // the second hour is the outage buffer; the day's claim makes it once
const BRIEF_FROM = 18;
const BRIEF_TO = 22; // a shoot booked tonight for tomorrow still gets its brief
const ACCESS_GAP = "no lockbox / access answer on the appointment";
export const ACCESS_TASK_PREFIX = "shoot-access-missing:";

const etDow = (d: Date) => new Date(`${etDayKey(d)}T12:00:00Z`).getUTCDay(); // 0 = Sunday
const street = (t: string | null | undefined) => (t ?? "").split(",")[0].trim() || "a job";
const first = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || "";
const ageWords = (h: number) => (h < 24 ? `${Math.max(0, Math.round(h))}h` : `${Math.round(h / 24)}d`);

/** "12 Oak St, 4 Elm Rd and 3 more" */
function listOf(items: string[], max = 3): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

const claim = async (key: string, value = new Date().toISOString()): Promise<boolean> => {
  try {
    await prisma.appSetting.create({ data: { key, value, updatedBy: "evening-push" } });
    return true;
  } catch {
    return false;
  }
};

/** Jordan: the OWNER login's roster row (the oldest active owner login that is
 *  linked to one). Never a name search; null when no owner login is linked. */
export async function ownerDeskId(): Promise<string | null> {
  const login = await prisma.appUser.findFirst({
    where: { role: "OWNER", status: "ACTIVE", teamMemberId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { teamMemberId: true },
  });
  if (!login?.teamMemberId) return null;
  const tm = await prisma.teamMember.findFirst({ where: { id: login.teamMemberId, active: true }, select: { id: true } });
  return tm?.id ?? null;
}

// ---- the wrap -----------------------------------------------------------------

/** Who has a late job, from what is holding it (deliveryBoard's blocker). */
function lateOwner(j: BoardJob, editorOf: Map<string, string | null>, kyleFirst: string): string {
  switch (j.blocker) {
    case "editing":
    case "ready_to_edit":
    case "handoff_incomplete":
    case "revision":
      return first(editorOf.get(j.id)) || kyleFirst;
    case "not_shot":
    case "awaiting_upload":
      return first(j.photographer) || kyleFirst;
    case "on_hold":
      return "on hold";
    default:
      return kyleFirst; // qc, ready: the delivery is Kyle's
  }
}

export type EveningWrap = { lines: string[]; text: string };

/** The wrap's lines from Home's own reads. Pure apart from the asks it is handed. */
export function composeEveningWrap(input: {
  now: Date;
  day: OpsDay;
  board: DeliveryBoard;
  editorOf: Map<string, string | null>;
  kyleFirst: string;
  kyleAsks: { title: string; ageDays: number }[];
  jordanAsksOld: { title: string; ageDays: number }[];
  cutsWaitingOnJordan: number;
  photoDecisions: number;
  /** tasks whose status says they wait on Jordan (WAITING_JORDAN) */
  tasksWaitingOnJordan?: number;
  link: string;
}): EveningWrap {
  const { now, day, board } = input;
  const todayKey = etDayKey(now);
  const tomorrowKey = etDayKey(new Date(now.getTime() + DAY));
  const nineTomorrow = etAt(tomorrowKey, 9);
  const lines: string[] = [];
  lines.push(`6 PM wrap, ${etDate(now)}`);

  const deliveredToday = board.unavailable ? null : board.delivered.filter((j) => j.deliveredAt && etDayKey(j.deliveredAt) === todayKey);
  lines.push(deliveredToday === null ? "Delivered today: the board could not be read" : `Delivered today (${deliveredToday.length}): ${deliveredToday.length ? listOf(deliveredToday.map((j) => street(j.title)), 4) : "none"}`);

  const live = board.unavailable ? [] : [...board.today, ...board.tomorrow];
  const dueSoon = live.filter((j) => j.dueAt && !j.overdue && j.dueAt.getTime() >= now.getTime() && j.dueAt.getTime() <= nineTomorrow.getTime());
  if (!board.unavailable) {
    lines.push(`Due by 9 AM tomorrow, not out (${dueSoon.length}): ${dueSoon.length ? listOf(dueSoon.map((j) => `${street(j.title)} (${j.blockerLabel})`)) : "none"}`);
  }
  const late = board.unavailable ? [] : board.today.filter((j) => j.overdue);
  if (!board.unavailable) {
    lines.push(`Late (${late.length}): ${late.length ? listOf(late.map((j) => `${street(j.title)} (${j.blockerLabel}, ${lateOwner(j, input.editorOf, input.kyleFirst)})`)) : "none"}`);
  }

  if (input.kyleAsks.length) {
    lines.push(`Kyle's asks to you (${input.kyleAsks.length}): ${listOf(input.kyleAsks.map((a) => `${a.title} (${a.ageDays}d)`), 2)}`);
  }
  const waiting = [
    input.cutsWaitingOnJordan ? `${input.cutsWaitingOnJordan} cut${input.cutsWaitingOnJordan === 1 ? "" : "s"} to review` : null,
    input.photoDecisions ? `${input.photoDecisions} photo job${input.photoDecisions === 1 ? "" : "s"} needing a QC decision` : null,
    input.tasksWaitingOnJordan ? `${input.tasksWaitingOnJordan} task${input.tasksWaitingOnJordan === 1 ? "" : "s"} marked waiting on you` : null,
  ].filter(Boolean);
  if (waiting.length) lines.push(`Waiting on you: ${waiting.join(", ")}`);
  if (input.jordanAsksOld.length) {
    lines.push(`Your asks to Kyle open 3+ days (${input.jordanAsksOld.length}): ${listOf(input.jordanAsksOld.map((a) => `${a.title} (${a.ageDays}d)`), 2)}`);
  }

  const unanswered = day.unanswered.all ?? day.unanswered.preview;
  lines.push(`Unanswered clients (${day.closeout.unanswered}): ${unanswered.length ? listOf(unanswered.map((u) => `${u.name} ${ageWords(u.hours)}`)) : "none"}`);

  const gaps = day.tomorrowShoots.filter((s) => s.gaps.length > 0);
  lines.push(
    `Tomorrow: ${day.tomorrowShoots.length} shoot${day.tomorrowShoots.length === 1 ? "" : "s"}, ${day.closeout.tomorrowGaps} gap${day.closeout.tomorrowGaps === 1 ? "" : "s"}` +
      (gaps.length ? `: ${listOf(gaps.map((s) => `${street(s.title)} (${s.gaps.join(", ")})`), 2)}` : ""),
  );
  lines.push(input.link);
  const clean = lines.map((l) => noDashes(l));
  return { lines: clean, text: clean.join("\n") };
}

export type EveningPushResult = { sent: boolean; reason?: string; lines?: string[]; to?: string[] };

async function sendEveningWrap(now: Date, day: OpsDay): Promise<EveningPushResult> {
  const dayKey = etDayKey(now);
  const [jordanId, { kyleDesk }] = await Promise.all([ownerDeskId(), import("@/lib/kyleNotice")]);
  const kyle = await kyleDesk();
  if (!jordanId && !kyle) return { sent: false, reason: "no owner login linked to the roster and no delivery owner" };
  if (!(await claim(`evening-push:${dayKey}`))) return { sent: false, reason: "already sent today" };
  try {
    const { deliveryBoard } = await import("@/lib/deliveryBoard");
    const { kylesOpenAsksToJordan, jordansOpenAsksToKyle } = await import("@/lib/slackAskEvidence");
    const board = await deliveryBoard({ includeTest: false }).catch((): DeliveryBoard => ({ today: [], tomorrow: [], upcoming: [], delivered: [], overdueCount: 0, unavailable: true }));
    const lateIds = board.today.filter((j) => j.overdue).map((j) => j.id);
    const [editors, kyleAsks, jordanAsksOld, reviewQueue, photoDecisions, tasksWaitingOnJordan] = await Promise.all([
      lateIds.length ? prisma.project.findMany({ where: { id: { in: lateIds } }, select: { id: true, editor: { select: { name: true } } } }) : Promise.resolve([]),
      kylesOpenAsksToJordan({ now }).catch(() => []),
      jordansOpenAsksToKyle({ now, minAgeDays: 3 }).catch(() => []),
      import("@/lib/reviewRoom").then((m) => m.getReviewQueue({ includeTest: false })).catch(() => null),
      // The photo-delivery system's "needs a decision" pile (read only).
      prisma.photoJob.count({ where: { stage: "QC_REVIEW" } }).catch(() => 0),
      prisma.smartTask.count({ where: { status: "WAITING_JORDAN" } }).catch(() => 0),
    ]);
    const { appBase } = await import("@/lib/appUrl");
    const wrap = composeEveningWrap({
      now,
      day,
      board,
      editorOf: new Map(editors.map((e) => [e.id, e.editor?.name ?? null])),
      kyleFirst: first(kyle?.name) || "Kyle",
      kyleAsks,
      jordanAsksOld,
      cutsWaitingOnJordan: jordanId ? (reviewQueue?.pending ?? []).filter((c) => c.reviewer?.id === jordanId).length : 0,
      photoDecisions,
      tasksWaitingOnJordan,
      link: `${appBase()}/`,
    });
    const { notifyStaffSms } = await import("@/lib/notify");
    const to: string[] = [];
    if (jordanId) {
      const out = await notifyStaffSms([jordanId], wrap.text, "evening_push");
      to.push(...out.map((o) => `${o.name}:${o.outcome}`));
    }
    // Kyle's copy: no dollar figure ever reaches him (access.canSeeMoney).
    if (kyle && kyle.id !== jordanId) {
      const out = await notifyStaffSms([kyle.id], scrubMoney(`Copy of Jordan's ${wrap.text}`), "evening_push");
      to.push(...out.map((o) => `${o.name}:${o.outcome}`));
    }
    return { sent: true, lines: wrap.lines, to };
  } catch (e) {
    // Nothing went out: free the day so the next tick tries again.
    await prisma.appSetting.delete({ where: { key: `evening-push:${dayKey}` } }).catch(() => {});
    console.warn("sendEveningWrap failed", e);
    return { sent: false, reason: e instanceof Error ? e.message : "failed" };
  }
}

// ---- the night-before brief ---------------------------------------------------

const FEE_RE = /\b(fee|fees|tip|tax|discount|coupon|surcharge|travel|rush|same day|deposit|credit)\b/i;

/** "35 Photos; 2 x Twilight; Zillow 3D Home Tour", verbatim from the order. */
export function orderedWords(items: { title: string; quantity: number }[], deliverables: { type: string; label: string | null; quantity: number }[]): string {
  const lines = items.filter((i) => !FEE_RE.test(i.title)).map((i) => `${i.quantity > 1 ? `${i.quantity} x ` : ""}${i.title.trim()}`);
  if (lines.length) return lines.join("; ");
  return deliverables.map((d) => `${d.quantity > 1 ? `${d.quantity} x ` : ""}${d.label ?? d.type.replace(/_/g, " ").toLowerCase()}`).join("; ") || "nothing on the order yet";
}

const stripPrefix = (s: string) => s.replace(/^Client (?:request|access note) \([^)]*\):\s*/i, "").trim();

/** The brief's words for one shoot. Pure. */
export function composeShootBrief(s: OpsShoot, p: {
  /** no lockbox / access answer and no client note about access */
  noAccess: boolean;
  address: string;
  ordered: string;
  photoTarget: { low: number; high: number; target: number } | null;
  link: string;
}): string {
  const a = s.access;
  const lines = [
    `Shoot brief for tomorrow: ${s.timeISO ? etDateTime(s.timeISO) : "time not set yet"}`,
    `Where: ${p.address} (client: ${s.clientName})`,
    `Ordered: ${p.ordered}`,
  ];
  if (p.photoTarget) lines.push(`Photo target: ${p.photoTarget.low} to ${p.photoTarget.high} finals, no more than ${p.photoTarget.target}`);
  if (a.lockbox) lines.push(`Lockbox / door code: ${a.lockbox}`);
  if (a.access) lines.push(`Access: ${a.access}`);
  if (a.presence) lines.push(`Seller present: ${a.presence}`);
  if (a.special) lines.push(`Special instructions: ${a.special}`);
  if (a.orderNotes) lines.push(`Order notes: ${a.orderNotes}`);
  if (a.notes) lines.push(`Client notes: ${a.notes}`);
  const requests = [...new Set(s.specialRequests.map(stripPrefix).filter(Boolean))];
  if (requests.length) lines.push(`Client requests: ${requests.slice(0, 4).join(" | ")}`);
  if (p.noAccess) lines.push("Access: nothing on file yet. Kyle is getting it and will send it to you.");
  lines.push(`Shoot screen: ${p.link}`);
  return noDashes(scrubMoney(lines.join("\n")));
}

export type BriefResult = { sent: number; skipped: string[]; accessTasks: number };

/** `textOff` (Oct 23 2026): the photographer brief (lib/photographerBrief) is on
 *  and carries tomorrow's shoots, so this pass opens Kyle's access tasks only. */
async function sendShootBriefs(now: Date, day: OpsDay, textOff = false): Promise<BriefResult> {
  const shoots = day.tomorrowShoots;
  const out: BriefResult = { sent: 0, skipped: [], accessTasks: 0 };
  if (shoots.length === 0) return out;
  const rows = await prisma.project.findMany({
    where: { id: { in: shoots.map((s) => s.id) } },
    select: {
      id: true, title: true, addressLine: true, photographerId: true, photoTarget: true, squareFeet: true, shootDate: true, createdAt: true, clientId: true,
      orderItems: { where: { isCanceled: false }, select: { title: true, quantity: true } },
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, label: true, quantity: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { photoPolicyFor } = await import("@/lib/culling");
  const { notifyStaffSms } = await import("@/lib/notify");
  const { appBase } = await import("@/lib/appUrl");
  const { kyleDesk } = await import("@/lib/kyleNotice");
  const { mentionsAccess } = await import("@/lib/shootNotes");
  const kyle = await kyleDesk();
  for (const s of shoots) {
    const p = byId.get(s.id);
    if (!p || !p.shootDate) continue;
    const shootDay = etDayKey(p.shootDate);
    await markShootSeen(p.id, shootDay);
    // ACCESS MISSING → one task for Kyle, whatever happens to the brief. A
    // client note that says how to get in (shootNotes.ts files those on the
    // job) counts as access on file.
    const noAccess = s.gaps.includes(ACCESS_GAP) && !s.specialRequests.some((r) => mentionsAccess(r));
    if (noAccess) {
      try {
        await prisma.smartTask.create({
          data: {
            taskType: "todo",
            title: `Get access details: ${street(s.title)} (shoot ${etDateTime(p.shootDate)})`.slice(0, 120),
            summary: `Tomorrow's shoot has no lockbox or access answer on the appointment and no client note about access. Get it from ${s.clientName} and put it on the job (a note on the job, or the Aryeo appointment) so the photographer has it.`.slice(0, 500),
            reasonCreated: "Night-before shoot brief: no access details on file",
            source: "system",
            priority: "HIGH",
            ownerId: kyle?.id ?? null,
            assignedKey: kyle?.key ?? null,
            projectId: p.id,
            clientId: p.clientId,
            propertyAddress: street(s.title),
            dueAt: new Date(Math.max(now.getTime() + HOUR, p.shootDate.getTime() - 2 * HOUR)),
            dedupeKey: `${ACCESS_TASK_PREFIX}${p.id}:${shootDay}`,
          },
        });
        out.accessTasks++;
      } catch { /* already open for this shoot day (P2002) */ }
    }
    if (textOff) continue;
    if (!p.photographerId) { out.skipped.push(`${street(s.title)}: no photographer assigned`); continue; }
    if (!(await claim(`shoot-brief:${p.id}:${shootDay}`, JSON.stringify({ to: p.photographerId, at: now.toISOString() })))) continue;
    const photos = p.deliverables.some((d) => d.type === "PHOTOS");
    const policy = photos ? photoPolicyFor(p) : null;
    const text = composeShootBrief(s, {
      noAccess,
      address: p.addressLine?.trim() && !/^\[No address/i.test(p.addressLine) ? `${p.addressLine.trim()}${p.title.includes(",") ? `, ${p.title.split(",").slice(1).join(",").trim()}` : ""}` : p.title,
      ordered: orderedWords(p.orderItems, p.deliverables),
      photoTarget: policy ? { low: policy.range.low, high: policy.range.high, target: policy.target } : null,
      link: `${appBase()}/shoot/${p.id}`,
    });
    const r = await notifyStaffSms([p.photographerId], text, "shoot_brief");
    if (r.some((o) => ["slack", "sent", "held", "deferred"].includes(o.outcome))) out.sent++;
    else out.skipped.push(`${street(s.title)}: ${r.map((o) => o.outcome).join(",") || "not reached"}`);
  }
  return out;
}

/** An access task closes itself once access is on file, and goes when the shoot has happened. */
export async function closeResolvedAccessTasks(now: Date = new Date()): Promise<{ closed: number }> {
  const open = await prisma.smartTask.findMany({
    where: { dedupeKey: { startsWith: ACCESS_TASK_PREFIX }, status: { notIn: ["COMPLETED", "CANCELLED"] }, projectId: { not: null } },
    select: { id: true, projectId: true, createdAt: true },
    take: 50,
  });
  if (open.length === 0) return { closed: 0 };
  const projects = await prisma.project.findMany({
    where: { id: { in: open.map((t) => t.projectId as string) } },
    select: {
      id: true, shootDate: true,
      appointments: { select: { description: true } },
      activities: { where: { type: "SPECIAL_REQUEST" }, select: { createdAt: true, body: true } },
    },
  });
  const { parseAccessBrief } = await import("@/lib/opsDay");
  const { mentionsAccess } = await import("@/lib/shootNotes");
  let closed = 0;
  for (const t of open) {
    const p = projects.find((x) => x.id === t.projectId);
    if (!p) continue;
    const brief = parseAccessBrief(p.appointments.map((a) => a.description?.trim()).find(Boolean) ?? null);
    const onFile = !!(brief.lockbox || brief.access || brief.presence || brief.special || brief.orderNotes || brief.notes) || p.activities.some((a) => a.createdAt > t.createdAt && mentionsAccess(a.body));
    const passed = !!p.shootDate && p.shootDate.getTime() < now.getTime() - 2 * HOUR;
    if (!onFile && !passed) continue;
    const r = await prisma.smartTask.updateMany({
      where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: onFile
        ? { status: "COMPLETED", completedAt: now, summary: "Closed: access details are on file for the shoot now." }
        : { status: "CANCELLED", summary: "Closed: the shoot has happened." },
    });
    closed += r.count;
  }
  return { closed };
}

// A shoot the brief pass has looked at for its day (brief sent or not, access
// task or not): the cheap pre-check below skips the Ops Day build once every
// shoot tomorrow has been seen and every assigned one has its brief.
const SEEN_PREFIX = "shoot-brief-seen:";
async function markShootSeen(projectId: string, shootDay: string): Promise<void> {
  await claim(`${SEEN_PREFIX}${projectId}:${shootDay}`);
}

/** Tomorrow's shoots that still need a look (a cheap read, so the heavy Ops Day
 *  build runs only when there is something to send). */
async function briefsOwed(now: Date, textOff = false): Promise<boolean> {
  const key = etDayKey(new Date(now.getTime() + DAY));
  const start = etAt(key, 0);
  const end = etAt(etDayKey(new Date(start.getTime() + 36 * HOUR)), 0);
  const shoots = await prisma.project.findMany({
    where: { shootDate: { gte: start, lt: end }, status: { notIn: ["CANCELLED", "ON_HOLD"] } },
    select: { id: true, shootDate: true, photographerId: true },
  });
  if (shoots.length === 0) return false;
  const keys = shoots.flatMap((s) => {
    const day = etDayKey(s.shootDate!);
    return [`${SEEN_PREFIX}${s.id}:${day}`, ...(s.photographerId && !textOff ? [`shoot-brief:${s.id}:${day}`] : [])];
  });
  const done = new Set((await prisma.appSetting.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((r) => r.key));
  // A photographer assigned after the first look still gets a brief.
  return keys.some((k) => !done.has(k));
}

export type EveningRun = { push: EveningPushResult | { skipped: string }; briefs: BriefResult | { skipped: string }; accessClosed: number };

/** Every 5 minutes (cron/gmail). Idle outside the evening windows. */
export async function runEveningAutomations(now: Date = new Date()): Promise<EveningRun> {
  const accessClosed = (await closeResolvedAccessTasks(now).catch(() => ({ closed: 0 }))).closed;
  const { internalAlertRules } = await import("@/lib/settings");
  const rules = await internalAlertRules();
  const hour = etHour(now);
  const dayKey = etDayKey(now);
  let pushWhy: string | null = null;
  if (!rules.eveningPush.enabled) pushWhy = "switched off (Settings, Internal alerts, Jordan's 6 PM wrap)";
  else if (hour < PUSH_FROM || hour >= PUSH_TO) pushWhy = `ET hour ${hour}, the wrap goes at 6 PM`;
  else if (etDow(now) === 0) pushWhy = "Sunday: no wrap";
  else if (await prisma.appSetting.findUnique({ where: { key: `evening-push:${dayKey}` }, select: { key: true } })) pushWhy = "already sent today";
  // THE PHOTOGRAPHER BRIEF (Oct 23 2026, lib/photographerBrief) replaces this
  // text while it is on; the access tasks below still open for Kyle.
  const { photographerBriefSettings } = await import("@/lib/photographerBrief");
  const textOff = (await photographerBriefSettings()).enabled;
  let briefWhy: string | null = null;
  if (!rules.photographerBrief.enabled) briefWhy = "switched off (Settings, Internal alerts, Night-before shoot brief)";
  else if (hour < BRIEF_FROM || hour >= BRIEF_TO) briefWhy = `ET hour ${hour}, briefs go from 6 PM`;
  else if (!(await briefsOwed(now, textOff))) briefWhy = textOff ? "every shoot tomorrow has been looked at (the photographer brief sends the texts)" : "every shoot tomorrow has its brief";
  if (pushWhy && briefWhy) return { push: { skipped: pushWhy }, briefs: { skipped: briefWhy }, accessClosed };

  // ONE Ops Day build for both, the same read Home renders (test clients out).
  const { buildOpsDay } = await import("@/lib/opsDay");
  const day = await buildOpsDay({ includeTest: false });
  const briefs = briefWhy ? { skipped: briefWhy } : await sendShootBriefs(now, day, textOff);
  const push = pushWhy ? { skipped: pushWhy } : await sendEveningWrap(now, day);
  return { push, briefs, accessClosed };
}
