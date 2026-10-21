import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { etDateTime, etDayKey } from "@/lib/datetime";
import { noDashes, scrubMoney } from "@/lib/text";
import { DEFAULT_TEXTS, type TextTemplateSet } from "@/lib/textTemplates";

// ---------------------------------------------------------------------------
// THE CHASE COUNTER (Oct 15 2026). A management report's top ask, after
// Marcee McMullen told Jordan she "had to keep asking for updates": clients
// should not have to chase, and when they do, a repeated follow-up escalates.
//
// Every inbound client message that asks "is it ready / any update"
// (promiseWatch.isReadyQuestion) is counted per client and job over 14 days:
//   · the 1st is the normal reply task (comms.ts already puts the promise and
//     the stage on it);
//   · the 2nd opens ONE HIGH task for Kyle (the delivery owner) carrying the
//     promise line and when they asked; a later ask updates that same task
//     while it is open;
//   · the 3rd and later also ring the owner: a bell row, and his Slack DM
//     through the staff path (notify.notifyStaffSms, which keeps his quiet
//     time).
// Tasks and bells only: nothing here contacts the client.
//
// IDEMPOTENT PER MESSAGE. The ledger is one AppSetting row per message
// ("chase:<client>:<job|->:<message>"), and the insert IS the claim: the same
// message re-ingested (a webhook retry, the Gmail sweep seeing it twice)
// counts once and escalates nothing. The message key is the CommLog id when
// the caller has one, else a hash of the words and the ET day.
// ---------------------------------------------------------------------------

export const CHASE_PREFIX = "chase:";
export const CHASE_WINDOW_DAYS = 14;
export const CHASE_TASK_TYPE = "client_chase";
const DAY = 86_400_000;

/** The owner's text on the third chase: the chase_owner template (Settings →
 *  Text messages, Oct 21 2026), no long dashes, no amounts. Pure. */
export function chaseOwnerText(o: { clientName: string; count: number; what: string; promise: string; link: string }, t: TextTemplateSet = DEFAULT_TEXTS): string {
  return noDashes(scrubMoney(t.render("chase_owner", { clientName: o.clientName, count: String(o.count), days: String(CHASE_WINDOW_DAYS), what: o.what, promise: o.promise, link: o.link })));
}

export type ChaseResult = {
  /** false = this message was already counted (nothing else happened) */
  recorded: boolean;
  /** asks from this client about this job in the last 14 days, this one included */
  count: number;
  escalated: "none" | "kyle" | "owner";
  taskId: string | null;
  skipped?: string;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);

/** The message's identity in the ledger. Pure. */
export function chaseMessageKey(input: { commLogId?: string | null; clientId: string; text: string; at: Date }): string {
  if (input.commLogId) return `log-${input.commLogId}`;
  return `h-${createHash("sha1").update(`${input.clientId}|${norm(input.text)}|${etDayKey(input.at)}`).digest("hex").slice(0, 16)}`;
}

export const chaseScope = (clientId: string, projectId: string | null) => `${CHASE_PREFIX}${clientId}:${projectId ?? "-"}:`;

type Entry = { at: string; snippet: string; source: string | null };

/** The asks on file for one client and job inside the window, oldest first. */
export async function chasesFor(clientId: string, projectId: string | null, now: Date = new Date()): Promise<{ key: string; at: Date; snippet: string }[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: chaseScope(clientId, projectId) } }, select: { key: true, value: true } });
  const floor = now.getTime() - CHASE_WINDOW_DAYS * DAY;
  const out: { key: string; at: Date; snippet: string }[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as Entry;
      const at = new Date(v.at);
      if (!isNaN(at.getTime()) && at.getTime() >= floor && at.getTime() <= now.getTime() + 60_000) out.push({ key: r.key, at, snippet: v.snippet ?? "" });
    } catch { /* a row that will not parse is not an ask */ }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Count one "is it ready / any update" message and escalate on the 2nd and 3rd. Never throws. */
export async function recordChase(input: {
  clientId: string;
  clientName: string;
  projectId: string | null;
  text: string;
  commLogId?: string | null;
  source?: string | null;
  at?: Date;
}): Promise<ChaseResult> {
  const at = input.at ?? new Date();
  const msgKey = chaseMessageKey({ commLogId: input.commLogId, clientId: input.clientId, text: input.text, at });
  const key = `${chaseScope(input.clientId, input.projectId)}${msgKey}`;
  try {
    const entry: Entry = { at: at.toISOString(), snippet: input.text.trim().slice(0, 160), source: input.source ?? null };
    const claimed = await prisma.appSetting
      .create({ data: { key, value: JSON.stringify(entry), updatedBy: "chase-counter" } })
      .then(() => true)
      .catch(() => false);
    if (!claimed) return { recorded: false, count: 0, escalated: "none", taskId: null, skipped: "already counted" };

    const asks = await chasesFor(input.clientId, input.projectId, at);
    const count = asks.length;
    if (count < 2) return { recorded: true, count, escalated: "none", taskId: null };
    const { programWatchRules } = await import("@/lib/programWatch");
    if (!(await programWatchRules()).chaseEscalation) return { recorded: true, count, escalated: "none", taskId: null, skipped: "switched off (Project Tracker, chase escalation)" };

    // ---- the task for Kyle --------------------------------------------------
    const project = input.projectId
      ? await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, title: true, contentMonthId: true } })
      : null;
    const what = project ? (project.contentMonthId ? "their videos" : (project.title ?? "").split(",")[0].trim() || "their job") : "their work";
    const { promiseLineFor } = await import("@/lib/promiseWatch");
    const promise = project ? await promiseLineFor(project.id, at).catch(() => "Promise on file: unknown.") : "No job matched these messages: find the job and its promise before replying.";
    const when = asks.map((a) => etDateTime(a.at)).join(", ");
    const title = noDashes(`${input.clientName} has asked for an update ${count} times: ${what}`).slice(0, 120);
    const summary = noDashes(scrubMoney(
      `${promise}\nAsked ${count} times in ${CHASE_WINDOW_DAYS} days (${when} ET). Reply with where it stands and a date the office stands behind, and get ahead of the next one. Nothing has been sent to the client.`,
    )).slice(0, 500);
    const description = noDashes(scrubMoney(asks.map((a) => `${etDateTime(a.at)} ET: "${a.snippet}"`).join("\n"))).slice(0, 2000);
    const { kyleDesk } = await import("@/lib/kyleNotice");
    const kyle = await kyleDesk();
    const data = {
      taskType: CHASE_TASK_TYPE,
      title,
      summary,
      description,
      reasonCreated: `Client asked for an update ${count} times in ${CHASE_WINDOW_DAYS} days`,
      source: "system",
      sourceDetail: "/tasks?tab=comms",
      priority: "HIGH",
      ownerId: kyle?.id ?? null,
      assignedKey: kyle?.key ?? null,
      clientId: input.clientId,
      projectId: project?.id ?? null,
      propertyAddress: project ? (project.title ?? "").split(",")[0].trim() || null : null,
      dueAt: new Date(at.getTime() + 60 * 60_000),
      status: "OPEN",
    };
    const open = await prisma.smartTask.findFirst({
      where: { taskType: CHASE_TASK_TYPE, clientId: input.clientId, projectId: project?.id ?? null, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    let taskId: string;
    if (open) {
      await prisma.smartTask.update({ where: { id: open.id }, data });
      taskId = open.id;
    } else {
      const dedupeKey = `chase:${input.clientId}:${project?.id ?? "-"}:${msgKey}`;
      taskId = await prisma.smartTask
        .create({ data: { ...data, dedupeKey }, select: { id: true } })
        .then((t) => t.id)
        .catch(async () => (await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } }))?.id ?? "");
      if (!taskId) return { recorded: true, count, escalated: "none", taskId: null, skipped: "the task could not be saved" };
    }
    if (project) {
      await prisma.activity
        .create({ data: { projectId: project.id, type: "SYSTEM", body: `Chase counter: ${input.clientName} asked for an update (${count} in ${CHASE_WINDOW_DAYS} days). Task for Kyle.`.slice(0, 300) } })
        .catch(() => {});
    }
    if (count < 3) return { recorded: true, count, escalated: "kyle", taskId };

    // ---- the 3rd: the owner hears it too ------------------------------------
    const { notifyInApp, notifyStaffSms } = await import("@/lib/notify");
    const { appBase } = await import("@/lib/appUrl");
    const bellTitle = noDashes(`${input.clientName} has chased ${count} times`).slice(0, 90);
    await notifyInApp({
      kind: CHASE_TASK_TYPE,
      title: bellTitle,
      body: noDashes(scrubMoney(`${what}. ${promise}`)).slice(0, 140),
      href: `/tasks?task=${taskId}`,
      targets: [{ roles: ["OWNER"] }],
      dedupeKey: `chase-owner-${input.clientId}-${project?.id ?? "-"}-${msgKey}`,
    }).catch(() => null);
    const { ownerDeskId } = await import("@/lib/eveningPush");
    const owner = await ownerDeskId().catch(() => null);
    if (owner) {
      const { loadTextTemplates } = await import("@/lib/textTemplateStore");
      const text = chaseOwnerText({ clientName: input.clientName, count, what, promise, link: `${appBase()}/tasks?task=${taskId}` }, await loadTextTemplates());
      await notifyStaffSms([owner], text, CHASE_TASK_TYPE).catch(() => null);
    }
    return { recorded: true, count, escalated: "owner", taskId };
  } catch (e) {
    console.warn("recordChase failed", e);
    return { recorded: false, count: 0, escalated: "none", taskId: null, skipped: "failed" };
  }
}
