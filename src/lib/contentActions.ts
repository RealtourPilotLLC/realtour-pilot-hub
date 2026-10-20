import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { contentHref } from "@/lib/contentNav";
import type { ScriptReadiness } from "@/lib/contentDrafting";

// ---------------------------------------------------------------------------
// MONTHLY CONTENT: WHAT NEEDS YOU, ON THE DASHBOARD (Oct 20 2026). Jordan:
// "I need to make sure we are able to see the scripts that need scripting",
// then, on seeing one line per script: "it can just say Ashley Brunner -
// October - Needs 4 Scripts, etc. I want it to be an update thing where I can
// see what actions are needed from me for the monthly content, whether its
// topics, or messages, etc."
//
// ONE ROW PER CLIENT AND MONTH (this month and next, real clients, live
// programs), each with the actions the office owes on it, in a few words:
//   · topics   — the month's next step when it is ours: pick the topics, keep
//                or drop the ones the call proposed (monthProgress.nextAction);
//   · scripts  — videos with no script that need a person (nothing to draft
//                from, thin answers, an unsettled plan; never one the hub
//                drafts itself, never a client who writes their own), drafts
//                waiting on an OK, drafts to finish, the client's change
//                requests and suggestions on shared scripts;
//   · messages — the client's portal messages nobody has answered;
//   · strategy — a strategy draft to approve, suggested changes to review,
//                topic ideas the client suggested.
// Reads only; no model call.
// ---------------------------------------------------------------------------

export type ActionItem = { key: string; words: string; tone: "warn" | "brand" | "muted"; href: string };
export type ContentActionRow = { key: string; clientName: string; monthKey: string; href: string; items: ActionItem[] };
export type ContentActions = { rows: ContentActionRow[] };

const NEEDS_A_PERSON: ReadonlySet<ScriptReadiness> = new Set<ScriptReadiness>(["THIN", "THIN_ANSWERS", "WAITING_ON_PLANNING"]);
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export async function monthlyContentActions(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<ContentActions> {
  const now = opts.now ?? new Date();
  const thisMonth = etMonthKey(now);
  const keys = [thisMonth, nextMonthKey(thisMonth)];
  const exclude = new Set(opts.excludeClientIds ?? []);
  const months = await prisma.contentMonth.findMany({
    where: { historical: false, monthKey: { in: keys }, ...(exclude.size ? { clientId: { notIn: [...exclude] } } : {}) },
    orderBy: { monthKey: "asc" },
    select: { id: true, monthKey: true, enrollmentId: true, clientId: true },
  });
  if (!months.length) return { rows: [] };
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { id: { in: [...new Set(months.map((m) => m.enrollmentId))] }, status: { not: "ENDED" } },
    select: { id: true, clientId: true, clientSuppliesTopics: true },
  });
  const live = new Map(enrollments.map((e) => [e.id, e]));
  const owed = months.filter((m) => live.has(m.enrollmentId));
  if (!owed.length) return { rows: [] };
  const clientIds = [...new Set(owed.map((m) => m.clientId))];
  const enrollmentIds = [...live.keys()];

  const [{ monthProgressMany, progressKey }, { scriptWorkForMonth }, { unansweredCount }] = await Promise.all([
    import("@/lib/monthProgress"),
    import("@/lib/contentDrafting"),
    import("@/lib/programMessages"),
  ]);
  const [progress, clients, draftStrategies, proposals, clientTopics, messages] = await Promise.all([
    monthProgressMany(owed.map((m) => ({ enrollmentId: m.enrollmentId, monthId: m.id, monthKey: m.monthKey })), { now, owners: true }),
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
    prisma.contentStrategyVersion.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: enrollmentIds }, status: "DRAFT" }, _count: { _all: true } }),
    prisma.contentStrategyProposal.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: enrollmentIds }, status: "PROPOSED" }, _count: { _all: true } }),
    prisma.contentTopic.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: enrollmentIds }, source: "client", approvalState: "PROPOSED" }, _count: { _all: true } }),
    Promise.all(enrollmentIds.map(async (id) => [id, await unansweredCount(id).catch(() => 0)] as const)),
  ]);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const countBy = (rows: { enrollmentId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.enrollmentId, r._count._all]));
  const drafts = countBy(draftStrategies), changes = countBy(proposals), ideas = countBy(clientTopics);
  const waiting = new Map(messages);

  // Videos that need a person to get a script, per month (six months at a time).
  const needScript = new Map<string, number>();
  for (let i = 0; i < owed.length; i += 6) {
    await Promise.all(owed.slice(i, i + 6).map(async (m) => {
      if (live.get(m.enrollmentId)?.clientSuppliesTopics) return;
      const work = await scriptWorkForMonth(m.id).catch(() => []);
      needScript.set(m.id, work.filter((w) => !w.scriptId && NEEDS_A_PERSON.has(w.readiness)).length);
    }));
  }

  const rows: ContentActionRow[] = [];
  const enrollmentDone = new Set<string>();
  for (const m of owed) {
    const p = progress.get(progressKey(m.enrollmentId, m.id, m.monthKey));
    const at = (tab: "plan" | "messages", view?: "topics" | "scripts" | "strategy") => contentHref(m.enrollmentId, { tab, view, month: m.monthKey, now });
    const items: ActionItem[] = [];
    const na = p?.nextAction;
    if (na && na.blocked === "us" && (na.ownerDuty === "strategy" || na.ownerDuty === "month reconciliation")) items.push({ key: "topics", words: na.text, tone: "warn", href: at("plan", "topics") });
    const write = needScript.get(m.id) ?? 0;
    if (write) items.push({ key: "write", words: `Needs ${n(write, "script")}`, tone: "warn", href: at("plan", "scripts") });
    if (p?.scripts.needsJordan) items.push({ key: "approve", words: `${n(p.scripts.needsJordan, "script")} to approve`, tone: "brand", href: at("plan", "scripts") });
    if (p?.scripts.drafting) items.push({ key: "drafting", words: `${n(p.scripts.drafting, "draft")} to finish`, tone: "brand", href: at("plan", "scripts") });
    if (p?.scripts.changesRequested) items.push({ key: "changes", words: `Changes asked on ${n(p.scripts.changesRequested, "script")}`, tone: "warn", href: at("plan", "scripts") });
    if (p?.scripts.openSuggestions) items.push({ key: "suggestions", words: `${n(p.scripts.openSuggestions, "script suggestion")} from the client`, tone: "brand", href: at("plan", "scripts") });
    // The account-wide ones ride on the client's first row.
    if (!enrollmentDone.has(m.enrollmentId)) {
      enrollmentDone.add(m.enrollmentId);
      const msgs = waiting.get(m.enrollmentId) ?? 0;
      if (msgs) items.push({ key: "messages", words: `${n(msgs, "message")} waiting on a reply`, tone: "warn", href: at("messages") });
      if (drafts.get(m.enrollmentId)) items.push({ key: "strategy", words: "Strategy to approve", tone: "brand", href: at("plan", "strategy") });
      const ch = changes.get(m.enrollmentId) ?? 0;
      if (ch) items.push({ key: "proposals", words: `${n(ch, "strategy change")} to review`, tone: "muted", href: at("plan", "strategy") });
      const id = ideas.get(m.enrollmentId) ?? 0;
      if (id) items.push({ key: "ideas", words: `${n(id, "topic idea")} from the client`, tone: "brand", href: at("plan", "topics") });
    }
    if (!items.length) continue;
    rows.push({ key: `${m.enrollmentId}:${m.monthKey}`, clientName: nameOf.get(m.clientId) ?? "A client", monthKey: m.monthKey, href: contentHref(m.enrollmentId, { month: m.monthKey, now }), items });
  }
  // What needs a person most first: rows with a warning, then this month before next, then by how much is on them.
  const warns = (r: ContentActionRow) => r.items.filter((i) => i.tone === "warn").length;
  rows.sort((a, b) => Number(warns(b) > 0) - Number(warns(a) > 0) || a.monthKey.localeCompare(b.monthKey) || b.items.length - a.items.length || a.clientName.localeCompare(b.clientName));
  return { rows };
}
