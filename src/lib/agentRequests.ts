import "server-only";
import { prisma } from "@/lib/prisma";
import { clip, scrubMoney } from "@/lib/text";
import {
  mergeAgentRequests, sameRequestWords, notDoneLine, notDoneMatches, parseNotDoneLine, NOT_DONE_PREFIX, NOT_DONE_WHY_CAP,
  type AgentRequestItem,
} from "@/lib/agentRequestsCore";

// ---------------------------------------------------------------------------
// THE AGENT'S REQUESTS FOR ONE JOB, as the upload page shows them (Oct 23
// 2026; the shapes and the merge rule are lib/agentRequestsCore). Read-only,
// from what is already saved, never retyped:
//   · the Aryeo order's special instructions and order notes, per visit
//     (clientAsks.orderNotesOf, the same reader the "Before you send" box and
//     Photo Delivery use; access and who-will-be-there lines are left out:
//     the shoot screen has those);
//   · the client's asks on the job (texts, emails, calls, staff-filed and
//     on-site ones): open ones are this shoot's, closed ones are history;
//   · what the office typed on the job (Activity SPECIAL_REQUEST);
//   · confirmed client preferences (clientFacts.productionFactsForBrief):
//     this job's, and the standing ones; a field report nobody has confirmed
//     yet is "not confirmed";
//   · the client's standing customer note.
//
// Only the owner reads the amounts; everyone else's copy is money-scrubbed
// (audit, Oct 23 2026: Kyle's request board's rule, clientAsks.viewerSeesMoney).
//
// AND ONE WRITE: a request the agent made ON SITE, logged by the photographer
// (addOnSiteRequest). It goes through the client-ask path every other request
// takes (clientAsks.createAsk and its dedupe), so it reaches Kyle's boards and
// holds delivery like a staff-filed ask, and as a "Client request (…)" line on
// the job so the editor's brief prints it. The same words already on the list
// are never filed twice.
// ---------------------------------------------------------------------------

const ON_SITE_REF = "on-site:";
const SOURCE_NAME: Record<string, string> = { text: "Text", email: "Email", call: "Call", staff: "Added by the office", portal: "Portal" };

export async function agentRequestsFor(
  projectId: string,
  /**
   * office: links to the job and the client. money: the words with their
   * amounts (audit, Oct 23 2026: the owner only, as clientAsks.viewerSeesMoney
   * and Kyle's request board have it; the old upload page showed the office
   * the creative customer note). Absent = office, for the callers that
   * already scrub by their own rule (the editor's brief).
   */
  opts: { office: boolean; money?: boolean; now?: Date },
): Promise<AgentRequestItem[]> {
  const now = opts.now ?? new Date();
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, clientId: true, status: true, deliveredAt: true,
      client: true,
      appointments: { select: { aryeoId: true, startAt: true, status: true } },
      activities: { where: { type: "SPECIAL_REQUEST" }, orderBy: { createdAt: "asc" }, select: { id: true, body: true, createdAt: true } },
    },
  });
  if (!p) return [];
  const money = opts.money ?? opts.office;
  const say = (t: string) => (money ? t : scrubMoney(t));
  const items: AgentRequestItem[] = [];
  const clientName = p.client?.name ?? "the agent";

  // Which visit is "this" one: the latest live appointment that has started,
  // else the next one. Notes on an earlier visit's appointment are history.
  const live = p.appointments.filter((a) => !/cancel/i.test(a.status ?? "") && a.startAt).sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime());
  const started = live.filter((a) => a.startAt!.getTime() <= now.getTime());
  const current = started[started.length - 1] ?? live[0] ?? null;
  const earlier = new Set(live.filter((a) => current && a.startAt!.getTime() < current.startAt!.getTime()).map((a) => a.aryeoId));

  // ---- order notes ----
  try {
    const { orderNotesOf } = await import("@/lib/clientAsks");
    for (const n of await orderNotesOf(projectId)) {
      if (!n.dedupeKey.startsWith("order-note:")) continue; // the order's add-ons are "What did you capture?", not a request
      items.push({
        id: `order:${n.dedupeKey}`,
        text: say(n.text.replace(/\s+/g, " ").trim()),
        original: say(n.text),
        source: "order_note",
        sourceWords: "Order notes (Aryeo)",
        atISO: n.askedAt ? n.askedAt.toISOString() : null,
        group: n.sourceRef && earlier.has(n.sourceRef) ? "history" : "visit",
        medium: n.medium ?? null,
        link: { href: `/shoot/${projectId}`, label: "Open the order on the shoot screen" },
      });
    }
  } catch { /* the order notes are still on the shoot screen */ }

  // ---- the client's asks ----
  const { isLiveAskSource, closesOnDelivery } = await import("@/lib/clientAsks");
  const asks = await prisma.clientAsk
    .findMany({
      where: { projectId, kind: "SPECIAL_REQUEST" },
      orderBy: { askedAt: "asc" },
      take: 100,
      select: { id: true, kind: true, text: true, summary: true, source: true, sourceRef: true, askedBy: true, askedAt: true, state: true, medium: true, doneBy: true, doneAt: true, confirmedBy: true, confirmedAt: true, confirmNote: true },
    })
    .catch(() => []);
  const since = now.getTime() - 60 * 86_400_000;
  // The asks this card shows: a job line below is folded into one of THESE
  // only (an ask left off the card must not take its copy with it).
  const shownAsks: { text: string; summary: string | null }[] = [];
  for (const a of asks) {
    if (!isLiveAskSource(a.source)) continue;
    const onSite = (a.sourceRef ?? "").startsWith(ON_SITE_REF);
    const open = a.state === "OPEN" && !closesOnDelivery(a, p);
    if (!open && (a.doneAt ?? a.confirmedAt ?? a.askedAt).getTime() < since) continue;
    shownAsks.push(a);
    const who = onSite ? decodeURIComponent((a.sourceRef ?? "").slice(ON_SITE_REF.length)) || "the photographer" : null;
    items.push({
      id: `ask:${a.id}`,
      text: say(a.summary?.trim() || clip(a.text.replace(/\s+/g, " "), 160)),
      original: say(a.text),
      source: onSite ? "on_site" : a.source === "staff" ? "office" : "client_ask",
      sourceWords: onSite
        ? `Asked on site, logged by ${who}`
        : a.source === "staff"
          ? "Added by the office"
          : `${SOURCE_NAME[a.source] ?? a.source} from ${a.askedBy?.trim() || clientName}`,
      atISO: a.askedAt.toISOString(),
      group: open ? "visit" : "history",
      medium: a.medium,
      link: opts.office ? { href: `/projects/${projectId}`, label: "Open the job" } : null,
      closedWords: open
        ? null
        : a.state === "CONFIRMED"
          ? `Confirmed by ${a.confirmedBy ?? "the office"}${a.confirmNote ? `: ${say(a.confirmNote)}` : ""}`
          : a.state === "NOT_NEEDED"
            ? `Not needed${a.confirmNote ? `: ${say(a.confirmNote)}` : ""}`
            : a.state === "DONE"
              ? `Done${a.doneBy ? ` (${a.doneBy})` : ""}`
              : "Closed when the job was delivered",
    });
  }

  // ---- what the office typed on the job ----
  const { isAccessNote, stripRequestLabel } = await import("@/lib/specialRequests");
  // Oct 27 2026: a request the photographer couldn't fulfill is a line of its
  // own; it is read back onto the request it is about, never shown as a new one.
  const notDone: { lineId: string; by: string; request: string; why: string }[] = [];
  for (const a of p.activities) {
    const body = (a.body ?? "").trim();
    if (!body) continue;
    const nd = parseNotDoneLine(body);
    if (nd) { notDone.push({ lineId: a.id, ...nd }); continue; }
    // Getting in (a code, a lockbox) is not a request: kept for reference,
    // folded with the history (the shoot screen is where it is used).
    if (isAccessNote(body)) {
      items.push({
        id: `access:${a.id}`,
        text: say(clip(stripRequestLabel(body).replace(/\s+/g, " "), 200)),
        original: say(stripRequestLabel(body)),
        source: "office",
        sourceWords: "Access note (also on the shoot screen)",
        atISO: a.createdAt.toISOString(),
        group: "history",
        medium: null,
        link: { href: `/shoot/${projectId}`, label: "Open the shoot screen" },
      });
      continue;
    }
    const copy = /^Client request \(([^)]*)\):/i.exec(body);
    const words = copy ? stripRequestLabel(body) : body;
    // A client's ask arrives as its own row above; this line is its copy for the editor's brief.
    if (copy && shownAsks.some((x) => sameRequestWords(x.text, words) || sameRequestWords(x.summary ?? "", words))) continue;
    const onSite = copy && /^on site/i.test(copy[1]);
    items.push({
      id: `line:${a.id}`,
      text: say(clip(words.replace(/\s+/g, " "), 200)),
      original: say(words),
      source: onSite ? "on_site" : copy ? "client_ask" : "office",
      sourceWords: onSite ? `Asked on site (${copy![1].replace(/^on site,?\s*/i, "")})` : copy ? `Client request (${copy[1]})` : "Added by the office",
      atISO: a.createdAt.toISOString(),
      group: "visit",
      medium: null,
      link: opts.office ? { href: `/projects/${projectId}`, label: "Open the job" } : null,
    });
  }

  // ---- confirmed preferences, and reports nobody has confirmed ----
  try {
    const { productionFactsForBrief, fieldReportsForProject } = await import("@/lib/clientFacts");
    const [facts, reports] = await Promise.all([
      productionFactsForBrief(p.clientId, projectId).catch(() => []),
      fieldReportsForProject(projectId).catch(() => []),
    ]);
    for (const f of facts) {
      items.push({
        id: `pref:${f.id}`,
        text: say(clip(f.body.replace(/\s+/g, " "), 200)),
        original: say(f.body),
        source: "preference",
        sourceWords: f.scope === "PERMANENT" ? "Client preference (confirmed, every job)" : f.scope === "MONTH" ? "Client preference (confirmed, this month)" : "Client preference (confirmed, this job)",
        atISO: f.factDate ? f.factDate.toISOString() : null,
        group: f.scope === "PERMANENT" ? "standing" : "visit",
        medium: null,
        link: opts.office ? { href: `/clients/${p.clientId}`, label: "Open the client" } : null,
      });
    }
    for (const r of reports) {
      if (r.status !== "PROPOSED") continue;
      items.push({
        id: `report:${r.id}`,
        text: say(clip(r.body.replace(/\s+/g, " "), 200)),
        original: say(r.body),
        source: "preference",
        sourceWords: `Reported from the field (${r.scope === "PROJECT" ? "this job" : "going forward"}), waiting for the office`,
        atISO: r.createdAt.toISOString(),
        group: "unresolved",
        medium: null,
        link: null,
      });
    }
  } catch { /* preferences are also on the editor's brief */ }

  // ---- the standing customer note ----
  try {
    const { customerNote, creativeCustomerNote } = await import("@/lib/clientNotes");
    const note = money ? customerNote(p.client) : creativeCustomerNote(p.client);
    if (note?.trim()) {
      items.push({
        id: "customer-note",
        text: clip(note.replace(/\s+/g, " ").trim(), 220),
        original: note.trim(),
        source: "customer_note",
        sourceWords: `Customer note for ${clientName} (Aryeo)`,
        atISO: null,
        group: "standing",
        medium: null,
        link: { href: `/shoot/${projectId}`, label: "Open the shoot screen" },
      });
    }
  } catch { /* the shoot screen shows it */ }

  const merged = mergeAgentRequests(items);
  // The latest answer wins (the lines are oldest first). One the list no
  // longer shows (the ask was closed and aged off) stays visible as history.
  for (const nd of notDone) {
    const view = { why: say(nd.why), by: nd.by || null, lineId: nd.lineId };
    const hit = merged.find((r) => notDoneMatches(r, nd.request));
    if (hit) { hit.notDone = view; continue; }
    merged.push({
      id: `notdone:${nd.lineId}`, text: say(nd.request), original: say(nd.request), source: "on_site",
      sourceWords: `Marked not done on site by ${nd.by || "the photographer"}`, atISO: null, group: "history", medium: null, link: null,
      closedWords: `Couldn't be done: ${say(nd.why)}`, notDone: view,
    });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// "I COULDN'T FULFILL THIS" (Jordan, Oct 27 2026, agentRequestsCore). One
// request, one answer: the job's "Not done on site" line (the editor's brief
// prints it with the special requests) and one task on Kyle's Follow-Ups, so
// the client hears it from the office. A second answer for the same request
// replaces the first; Undo takes both back while Kyle hasn't closed the task.
// ---------------------------------------------------------------------------

/** Short, stable key for one request on one job (the task's dedupe key). */
function requestKey(projectId: string, requestId: string): string {
  let h = 5381;
  for (const ch of requestId) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `request-not-done:${projectId}:${h.toString(36)}`;
}

export async function requestNotFulfilled(input: {
  projectId: string;
  requestId: string;
  why: string;
  by: { name: string };
  office: boolean;
  money?: boolean;
}): Promise<AddRequestResult> {
  const why = (input.why ?? "").replace(/\r\n/g, "\n").trim();
  if (why.length < 3) return { ok: false, message: "Say why it couldn't be done." };
  if (why.length > NOT_DONE_WHY_CAP) return { ok: false, message: `Keep the reason under ${NOT_DONE_WHY_CAP} characters.` };
  const p = await prisma.project.findUnique({ where: { id: input.projectId }, select: { title: true } });
  if (!p) return { ok: false, message: "Couldn't find that shoot." };
  // The words come from the server's own list (the office's copy, with the
  // amounts), never from the page: the page holds a money-scrubbed copy.
  const all = await agentRequestsFor(input.projectId, { office: true, money: true });
  const req = all.find((r) => r.id === input.requestId);
  if (!req || req.id.startsWith("notdone:")) return { ok: false, message: "That request isn't on this shoot any more. Reload the page." };
  const name = (input.by.name || "the photographer").trim().slice(0, 80);
  const body = notDoneLine(name, req.original, why);
  // One answer per request: an earlier line for it is replaced.
  const earlier = (await prisma.activity.findMany({ where: { projectId: input.projectId, type: "SPECIAL_REQUEST", body: { startsWith: NOT_DONE_PREFIX } }, select: { id: true, body: true } }))
    .filter((a) => { const nd = parseNotDoneLine(a.body); return !!nd && notDoneMatches(req, nd.request); });
  if (!earlier.some((a) => a.body === body)) {
    await prisma.activity.create({ data: { projectId: input.projectId, type: "SPECIAL_REQUEST", body } });
    if (earlier.length) await prisma.activity.deleteMany({ where: { id: { in: earlier.map((a) => a.id) } } });
  }
  // Kyle's task (his Follow-Ups; the drawer's Mark done closes it).
  const street = (p.title || "the shoot").split(",")[0].trim();
  const dedupeKey = requestKey(input.projectId, input.requestId);
  const summary = `${name} couldn't do the agent's request on ${street}: "${clip(req.original.replace(/\s+/g, " "), 200)}". Why: ${clip(why.replace(/\s+/g, " "), 300)}. Let the client know, or plan how to make it right.`;
  try {
    const kyle = await import("@/lib/kyleNotice").then((m) => m.kyleDesk()).catch(() => null);
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, status: true } });
    if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { summary: summary.slice(0, 500), description: why } });
    } else if (existing) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { status: "OPEN", completedAt: null, summary: summary.slice(0, 500), description: why, dueAt: new Date(Date.now() + 24 * 3600_000) } });
    } else {
      await prisma.smartTask.create({
        data: {
          taskType: "internal_instruction",
          title: `Agent request not done on site: ${street}`.slice(0, 120),
          summary: summary.slice(0, 500),
          description: why,
          reasonCreated: "The photographer marked an agent request they couldn't fulfill on the upload page.",
          source: "manual",
          priority: "HIGH",
          // Telling the client is a next-morning job, like the add-ons logged on site.
          dueAt: new Date(Date.now() + 24 * 3600_000),
          assignedKey: kyle?.key ?? "kyle",
          ownerId: kyle?.id ?? null,
          projectId: input.projectId,
          propertyAddress: p.title,
          // clientId stays null: a client's next message must never merge into
          // (and retitle) this task (the add-on task's rule, upload/actions.ts).
          contactName: name,
          dedupeKey,
        },
      });
    }
  } catch (e) {
    // The line above is saved either way; the hourly pass does not recreate this task, so say so.
    console.warn("[agent-requests] the office task was not filed", input.projectId, (e as Error)?.message);
    return { ok: true, message: "Saved on the editor's brief, but the office task didn't go through. Tell Kyle.", items: await agentRequestsFor(input.projectId, { office: input.office, money: input.money ?? false }) };
  }
  return {
    ok: true,
    message: "Saved. Kyle has it on his follow-ups, and the editor's brief says it wasn't done.",
    items: await agentRequestsFor(input.projectId, { office: input.office, money: input.money ?? false }),
  };
}

/** Undo "I couldn't fulfill this": the line goes, and Kyle's task with it unless he already closed it. */
export async function withdrawNotFulfilled(input: { projectId: string; requestId: string; office: boolean; money?: boolean }): Promise<AddRequestResult> {
  const all = await agentRequestsFor(input.projectId, { office: true, money: true });
  const req = all.find((r) => r.id === input.requestId);
  if (!req?.notDone) return { ok: true, message: "Nothing to undo.", items: await agentRequestsFor(input.projectId, { office: input.office, money: input.money ?? false }) };
  const lines = (await prisma.activity.findMany({ where: { projectId: input.projectId, type: "SPECIAL_REQUEST", body: { startsWith: NOT_DONE_PREFIX } }, select: { id: true, body: true } }))
    .filter((a) => { const nd = parseNotDoneLine(a.body); return !!nd && (a.id === req.notDone!.lineId || notDoneMatches(req, nd.request)); });
  if (lines.length) await prisma.activity.deleteMany({ where: { id: { in: lines.map((a) => a.id) } } });
  const dedupeKey = requestKey(input.projectId, input.requestId);
  await prisma.smartTask.updateMany({ where: { dedupeKey, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "CANCELLED" } }).catch(() => null);
  return { ok: true, message: "Taken back.", items: await agentRequestsFor(input.projectId, { office: input.office, money: input.money ?? false }) };
}

export type AddRequestResult = { ok: boolean; duplicate?: boolean; message: string; items?: AgentRequestItem[] };

/**
 * A request the agent made at the shoot that is not in the hub yet. Never a
 * second copy of one already on the list (the order's notes, the client's
 * asks, the office's lines, a preference): those are named back instead.
 */
export async function addOnSiteRequest(input: {
  projectId: string;
  text: string;
  medium: "photo" | "video" | "both";
  by: { name: string };
  office: boolean;
  /** the words with their amounts (the owner only; agentRequestsFor) */
  money?: boolean;
}): Promise<AddRequestResult> {
  const text = (input.text ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length < 3) return { ok: false, message: "Write what the agent asked for." };
  if (text.length > 1000) return { ok: false, message: "That is a long request. Keep it under 1,000 characters, and put the rest in your instructions." };
  const p = await prisma.project.findUnique({ where: { id: input.projectId }, select: { clientId: true, title: true, client: { select: { name: true } } } });
  if (!p) return { ok: false, message: "Couldn't find that shoot." };
  const before = await agentRequestsFor(input.projectId, { office: true });
  const twin = before.find((r) => r.group !== "history" && sameRequestWords(r.original, text));
  if (twin) return { ok: true, duplicate: true, message: `Already on the list (${twin.sourceWords}): ${input.money ? twin.text : scrubMoney(twin.text)}`, items: await agentRequestsFor(input.projectId, { office: input.office, money: input.money ?? false }) };
  const name = (input.by.name || "the photographer").trim().slice(0, 80);
  const { createAsk } = await import("@/lib/clientAsks");
  const r = await createAsk({
    clientId: p.clientId,
    projectId: input.projectId,
    kind: "SPECIAL_REQUEST",
    medium: input.medium,
    text,
    summary: clip(text.replace(/\s+/g, " "), 140),
    // A staff-filed ask: it is on Kyle's boards and holds delivery until it is
    // checked, like the office's own "Add a request" (clientAsks.addAskByHand).
    source: "staff",
    sourceRef: `${ON_SITE_REF}${encodeURIComponent(name)}`,
    askedBy: p.client?.name ?? null,
    holdsDelivery: true,
    by: `${name} (on site)`,
    // No key given: the ask's own words key (client + job + words), and the
    // 48-hour same-words check every ask from a message goes through.
  });
  if (!r) return { ok: false, message: "Write what the agent asked for." };
  if (r.created) {
    // The editor's brief, the packet and the printed brief read the job's
    // SPECIAL_REQUEST lines (lib/specialRequests).
    const body = `Client request (on site, logged by ${name}): ${clip(text, 280)}`;
    const already = await prisma.activity.findFirst({ where: { projectId: input.projectId, type: "SPECIAL_REQUEST", body }, select: { id: true } });
    if (!already) await prisma.activity.create({ data: { projectId: input.projectId, type: "SPECIAL_REQUEST", body } });
    // A photo request on photos already delivered reopens the photo job, as the office's own does.
    if (input.medium !== "video") {
      try {
        const { photoAskAfterDelivery } = await import("@/lib/photoDelivery/clientAsked");
        await photoAskAfterDelivery({ projectId: input.projectId, words: text, by: name, clientId: p.clientId });
      } catch { /* the ask is filed either way */ }
    }
  }
  const items = await agentRequestsFor(input.projectId, { office: input.office, money: input.money ?? false });
  return {
    ok: true,
    duplicate: !r.created,
    message: r.created ? "Added. Kyle sees it on the requests list, and it's on the editor's brief." : "That request was already filed for this job, so nothing new was added.",
    items,
  };
}
