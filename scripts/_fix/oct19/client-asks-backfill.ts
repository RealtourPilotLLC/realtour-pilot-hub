// ---------------------------------------------------------------------------
// LIVE (Oct 19 2026): the client asks that were standing before the
// ClientAsk table existed (lib/clientAsks). From the deploy on, the hub files
// them by itself (the Smart Brain's read of each text and email, the Aryeo
// import, the portal desk); this files what was already open:
//
//   1. ORDER NOTES AND ADD-ONS on every job not yet delivered (shot or ordered
//      in the last 45 days, test clients left out): the customer's Special
//      Instructions / Order Notes (access lines dropped) and add-ons a person
//      must check (Lot Lines, Virtual Twilight, Virtual Staging...). No model.
//   2. SPECIAL REQUESTS from the last 14 days of each such client's texts and
//      emails: ONE model call per client, reading the whole timed conversation
//      (ours too) and listing the asks still standing on those jobs. Our reply
//      never finishes an ask; only the client withdrawing it, or saying the
//      finished work is right, leaves it out. A text or email ask holds the
//      job's delivery until Kyle confirms it.
//   3. SCHEDULING asks from the last 7 days: the same call for those clients,
//      plus one call for each other client whose last-7-day messages read as
//      scheduling talk; moves and postponements Aryeo recorded in the last 48
//      hours; open portal session requests on Kyle's desk.
//
// DRY RUN by default, on a read-only connection (proved with SQLSTATE 25006
// before anything is read): prints every ask it would file and how many model
// calls it made. --apply files them (each once: dedupe keys). Flags:
//   --no-model     skip step 2/3's model calls (order notes, Aryeo, portal only)
//   --client "<name part>"   only clients whose name contains this
//
//   set -a && source .env && set +a
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct19/client-asks-backfill.ts [--apply]
// ---------------------------------------------------------------------------
export {};
const APPLY = process.argv.includes("--apply");
const NO_MODEL = process.argv.includes("--no-model");
const clientArg = (() => {
  const i = process.argv.indexOf("--client");
  return i > 0 ? (process.argv[i + 1] ?? "").toLowerCase() : "";
})();
if (!APPLY && process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${process.env.DATABASE_URL.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
}

const DAY = 86_400_000;

type Candidate = {
  clientId: string;
  clientName: string;
  projectId: string | null;
  street: string | null;
  kind: "SPECIAL_REQUEST" | "SCHEDULING";
  medium: string | null;
  text: string;
  summary: string | null;
  source: string;
  sourceRef: string | null;
  askedBy: string | null;
  askedAt: Date;
  holdsDelivery: boolean;
  dedupeKey: string;
  why: string;
};

async function main() {
  const { prisma } = await import("@/lib/prisma");
  if (!APPLY) {
    try {
      await prisma.$executeRawUnsafe(`UPDATE "Client" SET "name" = "name" WHERE false`);
      throw new Error("GUARD FAILED: the dry-run connection accepted a write; nothing was read");
    } catch (e) {
      if (!/25006|read-only/i.test(String(e))) throw e;
    }
    console.log("Read-only connection proven (SQLSTATE 25006). DRY RUN: nothing is written.\n");
  } else {
    console.log("APPLY: asks are written.\n");
  }
  const crypto = await import("crypto");
  const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 24);
  const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const ca = await import("@/lib/clientAsks");
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const { aryeoCustomerNote } = await import("@/lib/shoot");
  const { isAccessNote } = await import("@/lib/specialRequests");
  const { askMedium, isSchedulingTalk } = await import("@/lib/comms");
  const { etDateTime, etDate } = await import("@/lib/datetime");
  const { etStamp } = await import("@/lib/conversationContext");
  const now = new Date();
  const out: Candidate[] = [];
  let modelCalls = 0;
  const modelErrors: string[] = [];
  const street = (t?: string | null) => (t ?? "").split(",")[0].trim() || null;

  // ---- 1. jobs in flight, their order notes and add-ons ---------------------
  const jobs = (
    await prisma.project.findMany({
      where: {
        status: { notIn: ["DELIVERED", "CANCELLED"] },
        deliveredAt: null,
        OR: [{ shootDate: { gte: new Date(now.getTime() - 45 * DAY) } }, { createdAt: { gte: new Date(now.getTime() - 45 * DAY) } }],
      },
      select: {
        id: true, title: true, status: true, clientId: true, shootDate: true, createdAt: true,
        client: { select: { id: true, name: true } },
        appointments: { select: { aryeoId: true, description: true, createdAt: true } },
        orderItems: { select: { title: true, isCanceled: true } },
        deliverables: { select: { productTitle: true, removedFromOrderAt: true } },
      },
    })
  ).filter((j) => j.client && !isSyntheticClientRow({ id: j.client.id, name: j.client.name }) && (!clientArg || j.client.name.toLowerCase().includes(clientArg)));
  console.log(`${jobs.length} jobs not yet delivered (shot or ordered in the last 45 days, test clients left out).`);
  for (const j of jobs) {
    const cands = ca.orderAskCandidates({ ...j, clientName: j.client!.name }, { customerNote: aryeoCustomerNote, isAccessNote, askMedium });
    for (const c of cands) {
      out.push({
        clientId: j.clientId, clientName: j.client!.name, projectId: j.id, street: street(j.title), kind: "SPECIAL_REQUEST", medium: c.medium ?? null,
        text: c.text, summary: c.summary ?? null, source: "order_note", sourceRef: c.sourceRef ?? null, askedBy: c.askedBy ?? null,
        askedAt: c.askedAt ?? now, holdsDelivery: false, dedupeKey: c.dedupeKey, why: c.dedupeKey.startsWith("addon:") ? "add-on" : "order note",
      });
    }
  }

  // ---- 2 + 3. the conversation, one model call per client --------------------
  type Line = { n: number; id: string; at: Date; who: string; dir: string; channel: string; text: string };
  const linesFor = async (clientId: string, since: Date): Promise<Line[]> => {
    const rows = await prisma.commLog.findMany({
      where: { clientId, occurredAt: { gte: since }, channel: { in: ["text", "email", "call"] } },
      orderBy: { occurredAt: "asc" },
      take: 200,
      select: { id: true, occurredAt: true, direction: true, channel: true, contactName: true, body: true, source: true },
    });
    const seen = new Set<string>();
    const lines: Line[] = [];
    for (const r of rows) {
      const text = (r.body ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      // The same email read in two inboxes: once.
      const k = `${r.direction}|${norm(text).slice(0, 200)}|${Math.floor(r.occurredAt.getTime() / 120_000)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push({ n: lines.length + 1, id: r.id, at: r.occurredAt, dir: r.direction, channel: r.channel, who: r.direction === "out" ? (r.source?.startsWith("auto-") ? "Us (automatic)" : "Us") : r.contactName || "Client", text: text.slice(0, 500) });
    }
    return lines.slice(-80);
  };
  type ModelAsk = { kind: string; projectId: string | null; line: number; text: string; summary: string; medium: string };
  const extract = async (clientName: string, jobsBlock: string, lines: Line[], schedulingOnly: boolean, deliveredBlock = ""): Promise<ModelAsk[]> => {
    const { aiJson } = await import("@/lib/integrations/ai");
    modelCalls++;
    const today = now.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const prompt = [
      `Today is ${today} (Eastern). Client: ${clientName}.`,
      "",
      schedulingOnly ? "This client has no job we are still working on. Only list SCHEDULING asks." : "THEIR JOBS WE HAVE NOT DELIVERED YET (id | address | status | shoot | ordered):",
      schedulingOnly ? "" : jobsBlock,
      schedulingOnly || !deliveredBlock ? "" : "\nTHEIR JOBS ALREADY DELIVERED (context only: an ask about one of these is a revision, handled elsewhere, and is NOT listed):",
      schedulingOnly || !deliveredBlock ? "" : deliveredBlock,
      "",
      "THE CONVERSATION (oldest first; each line has a number; 'Us' lines are our team):",
      ...lines.map((l) => `[${l.n}] ${etStamp(l.at)} · ${l.who} (${l.channel}): ${l.text}`),
      "",
      "List every ask the CLIENT made in these messages that is still standing.",
      schedulingOnly
        ? ""
        : "- SPECIAL_REQUEST: a concrete instruction about what the photos or video for one of the jobs listed above must include or how they must look (for example lot lines drawn, lot numbers, overlays like an earlier output, things to avoid, a song, a shot to get). Only for the jobs listed. Not door, gate or lockbox codes or how to get in; not status questions; not thank-yous; not who does the shoot or what time it starts; not changes to other jobs.",
      `- SCHEDULING: in a message from ${etDate(new Date(now.getTime() - 7 * DAY))} or later only, the client asked to book, move, reschedule, postpone or cancel a shoot or session. A calendar invitation reply or other automatic notice is not an ask.`,
      "Our team's replies ('got it', 'we will', 'sending now') do NOT finish an ask: keep it. Leave an ask out only when the client later withdrew it ('never mind') or, after seeing the finished work, said it is right.",
      "When the client says to match an earlier output ('just like the Pennfield output'), the summary says what that output has, using only what these messages say about it (for example the lot numbers).",
      "For each ask: kind; projectId (one of the ids listed, or an empty string when unclear); line (the number of the client's message it comes from); text (the client's exact words from that line); summary (what must be checked or done, plain, max 14 words, no client name, no dashes); medium (video, photo, both or unclear). If one ask applies to several jobs, list it once per job. If an ask was repeated, list the clearest line once.",
    ].filter((x) => x !== "").join("\n");
    const r = await aiJson<{ asks: ModelAsk[] }>({
      system: "You read a real estate media agency's recent messages with one client and list what the client asked for that is still standing. You output only JSON. No em dashes.",
      prompt,
      schema: {
        type: "object",
        properties: {
          asks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: schedulingOnly ? ["SCHEDULING"] : ["SPECIAL_REQUEST", "SCHEDULING"] },
                projectId: { type: "string", description: "one of the job ids listed, or an empty string when unclear" },
                line: { type: "integer" },
                text: { type: "string" },
                summary: { type: "string" },
                medium: { type: "string", enum: ["video", "photo", "both", "unclear"] },
              },
              required: ["kind", "line", "text", "summary", "medium"],
            },
          },
        },
        required: ["asks"],
      },
      maxTokens: 1500,
    });
    return Array.isArray(r?.asks) ? r.asks : [];
  };
  const file = (clientId: string, clientName: string, jobIds: Map<string, string | null>, lines: Line[], asks: ModelAsk[], onlyJobInFlight: string | null = null) => {
    for (const a of asks) {
      const kind = a.kind === "SCHEDULING" ? "SCHEDULING" : "SPECIAL_REQUEST";
      const line = lines.find((l) => l.n === a.line && l.dir === "in");
      if (!line) continue; // not a client's line: nothing grounded to file
      if (kind === "SCHEDULING" && line.at.getTime() < now.getTime() - 7 * DAY) continue;
      const words = (a.text || "").trim() || line.text;
      if (isAccessNote(words)) continue;
      // A special request with no clear job, from a client with exactly one job
      // in flight, is about that job (the same rule the live filing uses).
      const projectId = a.projectId && jobIds.has(a.projectId) ? a.projectId : kind === "SPECIAL_REQUEST" ? onlyJobInFlight : null;
      const source = line.channel === "email" ? "email" : line.channel === "call" ? "call" : "text";
      out.push({
        clientId, clientName, projectId, street: projectId ? jobIds.get(projectId) ?? null : null, kind, medium: kind === "SCHEDULING" ? null : ca.asMedium(a.medium),
        text: words.slice(0, 1200), summary: (a.summary || "").replace(/[–—]/g, ",").slice(0, 200) || null, source, sourceRef: line.id,
        askedBy: line.who, askedAt: line.at, holdsDelivery: kind === "SPECIAL_REQUEST" && ["text", "email", "call"].includes(source),
        dedupeKey: `backfill:${sha([clientId, projectId ?? "-", kind, norm(words)].join("|"))}`, why: `model, line ${a.line}`,
      });
    }
  };

  const byClient = new Map<string, typeof jobs>();
  for (const j of jobs) byClient.set(j.clientId, [...(byClient.get(j.clientId) ?? []), j]);
  for (const [clientId, cj] of byClient) {
    const lines = await linesFor(clientId, new Date(now.getTime() - 14 * DAY));
    if (!lines.some((l) => l.dir === "in")) continue;
    if (NO_MODEL) { console.log(`  (skipped model) ${cj[0].client!.name}: ${lines.length} lines`); continue; }
    const jobsBlock = cj
      .map((j) => `${j.id} | ${j.title} | ${j.status} | ${j.shootDate ? etDateTime(j.shootDate) : "no shoot date"} | ${[...new Set(j.orderItems.filter((i) => !i.isCanceled).map((i) => i.title))].join(", ") || "?"}`)
      .join("\n");
    const delivered = await prisma.project.findMany({
      where: { clientId, OR: [{ deliveredAt: { gte: new Date(now.getTime() - 30 * DAY) } }, { status: { in: ["DELIVERED", "REVISION"] }, updatedAt: { gte: new Date(now.getTime() - 30 * DAY) } }], id: { notIn: cj.map((j) => j.id) } },
      take: 10,
      select: { title: true, status: true, deliveredAt: true },
    });
    const deliveredBlock = delivered.map((d) => `${d.title} | ${d.status}${d.deliveredAt ? ` | delivered ${etDateTime(d.deliveredAt)}` : ""}`).join("\n");
    try {
      const asks = await extract(cj[0].client!.name, jobsBlock, lines, false, deliveredBlock);
      file(clientId, cj[0].client!.name, new Map(cj.map((j) => [j.id, street(j.title)])), lines, asks, cj.length === 1 ? cj[0].id : null);
    } catch (e) {
      modelErrors.push(`${cj[0].client!.name}: ${(e as Error).message}`);
    }
  }

  // Scheduling-only: other clients whose last-7-day messages read as scheduling talk.
  const recentIn = await prisma.commLog.findMany({
    where: { direction: "in", channel: { in: ["text", "email"] }, occurredAt: { gte: new Date(now.getTime() - 7 * DAY) }, clientId: { not: null } },
    select: { clientId: true, body: true },
  });
  const schedClients = [...new Set(recentIn.filter((r) => r.clientId && !byClient.has(r.clientId) && (isSchedulingTalk(r.body ?? "") || /\bcancel\w*\b/i.test(r.body ?? ""))).map((r) => r.clientId!))];
  const schedRows = schedClients.length ? await prisma.client.findMany({ where: { id: { in: schedClients } }, select: { id: true, name: true } }) : [];
  const schedReal = schedRows.filter((c) => !isSyntheticClientRow(c) && (!clientArg || c.name.toLowerCase().includes(clientArg)));
  console.log(`${byClient.size} clients with work in flight; ${schedReal.length} more whose last week reads as scheduling talk.`);
  for (const c of schedReal) {
    const lines = await linesFor(c.id, new Date(now.getTime() - 7 * DAY));
    if (!lines.some((l) => l.dir === "in")) continue;
    if (NO_MODEL) { console.log(`  (skipped model) ${c.name}: ${lines.length} lines`); continue; }
    try {
      const asks = await extract(c.name, "", lines, true);
      const projects = await prisma.project.findMany({ where: { clientId: c.id }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, title: true } });
      file(c.id, c.name, new Map(projects.map((p) => [p.id, street(p.title)])), lines, asks.filter((a) => a.kind === "SCHEDULING"));
    } catch (e) {
      modelErrors.push(`${c.name}: ${(e as Error).message}`);
    }
  }

  // Aryeo: moves and postponements recorded in the last 48 hours.
  const since48 = new Date(now.getTime() - 48 * 3_600_000);
  const appts = await prisma.appointment.findMany({
    where: { OR: [{ rescheduledAt: { gte: since48 } }, { postponedAt: { gte: since48 } }] },
    select: { aryeoId: true, startAt: true, previousStartAt: true, rescheduledAt: true, postponedAt: true, projectId: true, project: { select: { title: true, clientId: true, client: { select: { id: true, name: true } } } } },
  });
  for (const a of appts) {
    const cl = a.project?.client;
    if (!cl || isSyntheticClientRow(cl) || (clientArg && !cl.name.toLowerCase().includes(clientArg))) continue;
    const postponed = !a.startAt && !!a.postponedAt && a.postponedAt >= since48;
    const keyPart = postponed ? `tbd-${(a.previousStartAt ?? a.postponedAt!).toISOString()}` : a.startAt ? a.startAt.toISOString() : "unknown";
    const st = street(a.project?.title) ?? "the shoot";
    out.push({
      clientId: cl.id, clientName: cl.name, projectId: a.projectId, street: st, kind: "SCHEDULING", medium: null,
      text: postponed ? `Postponed in Aryeo, new date to be set: ${st}.` : `Moved in Aryeo: ${st} to ${etDateTime(a.startAt)}${a.previousStartAt ? ` (was ${etDateTime(a.previousStartAt)})` : ""}.`,
      summary: postponed ? "Shoot postponed in Aryeo: follow up for a new date" : `Shoot moved to ${etDateTime(a.startAt)}: tell the photographer and confirm with the client`,
      source: "aryeo", sourceRef: a.aryeoId, askedBy: null, askedAt: (postponed ? a.postponedAt : a.rescheduledAt) ?? now, holdsDelivery: false,
      dedupeKey: `aryeo-change:${a.aryeoId}:${keyPart}`, why: "Aryeo change",
    });
  }

  // Portal session requests waiting on Kyle's desk.
  const reqs = await prisma.programSessionRequest.findMany({
    where: { status: { in: ["REQUESTED", "CANCEL_REQUESTED"] }, taskId: { not: null } },
    select: { id: true, status: true, clientId: true, projectId: true, slotStart: true, notes: true, supersedesId: true, taskId: true },
  });
  const openTasks = new Set((await prisma.smartTask.findMany({ where: { id: { in: reqs.map((r) => r.taskId!) }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true } })).map((t) => t.id));
  const reqClients = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(reqs.map((r) => r.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c]));
  for (const r of reqs) {
    const cl = reqClients.get(r.clientId);
    if (!cl || isSyntheticClientRow(cl) || !openTasks.has(r.taskId!) || (clientArg && !cl.name.toLowerCase().includes(clientArg))) continue;
    const mode = r.status === "CANCEL_REQUESTED" ? "CANCEL" : r.supersedesId ? "RESCHEDULE" : "BOOK";
    const when = r.slotStart ? etDateTime(r.slotStart) : "no slot picked";
    out.push({
      clientId: cl.id, clientName: cl.name, projectId: r.projectId, street: null, kind: "SCHEDULING", medium: null,
      text: mode === "BOOK" ? `Asked on the portal for a content session: ${when}.` : mode === "CANCEL" ? `Asked on the portal to cancel the session: ${when}.` : `Asked on the portal to move the session to ${when}.`,
      summary: mode === "BOOK" ? "Book the content session the client asked for" : mode === "CANCEL" ? "Cancel the session in Aryeo and confirm with the client" : "Move the session in Aryeo and confirm with the client",
      source: "portal", sourceRef: r.id, askedBy: null, askedAt: now, holdsDelivery: false, dedupeKey: `portal-session:${r.id}:${mode}`, why: "portal request",
    });
  }

  // ---- report -----------------------------------------------------------------
  let existing = new Set<string>();
  try {
    existing = new Set((await prisma.clientAsk.findMany({ where: { dedupeKey: { in: out.map((o) => o.dedupeKey) } }, select: { dedupeKey: true } })).map((r) => r.dedupeKey!));
  } catch {
    console.log("(The ClientAsk table is not in this database yet: every row below would be new.)");
  }
  const fresh = out.filter((o, i) => !existing.has(o.dedupeKey) && out.findIndex((x) => x.dedupeKey === o.dedupeKey) === i);
  const tally = (pred: (c: Candidate) => boolean) => fresh.filter(pred).length;
  console.log(`\nModel calls: ${modelCalls}${modelErrors.length ? ` (${modelErrors.length} failed: ${modelErrors.join(" | ")})` : ""}`);
  console.log(`Would file ${fresh.length} asks (${out.length - fresh.length} already filed or repeated):`);
  console.log(`  special requests from texts/emails: ${tally((c) => c.kind === "SPECIAL_REQUEST" && c.source !== "order_note")} (hold delivery: ${tally((c) => c.holdsDelivery)})`);
  console.log(`  order notes: ${tally((c) => c.why === "order note")} · add-ons to check: ${tally((c) => c.why === "add-on")}`);
  console.log(`  scheduling from texts/emails: ${tally((c) => c.kind === "SCHEDULING" && ["text", "email", "call"].includes(c.source))} · Aryeo changes: ${tally((c) => c.source === "aryeo")} · portal requests: ${tally((c) => c.source === "portal")}`);
  const show = (c: Candidate) =>
    `  ${c.kind === "SCHEDULING" ? "SCHED" : "SPECIAL"} | ${c.clientName} | ${c.street ?? "job unclear"} | ${c.source}${c.holdsDelivery ? " | HOLDS" : ""}${c.medium ? ` | ${c.medium}` : ""} | ${etStamp(c.askedAt)}\n      ${c.summary ?? ""}\n      "${c.text.replace(/\s+/g, " ").slice(0, 220)}"`;
  const barry = fresh.filter((c) => /barry/i.test(c.street ?? "") || (/barritt/i.test(c.clientName) && !c.projectId));
  console.log(`\n=== Barry Rd (Heather Barritt): ${barry.length} ===`);
  for (const c of barry) console.log(show(c));
  console.log(`\n=== Everything else (${fresh.length - barry.length}) ===`);
  for (const c of fresh.filter((x) => !barry.includes(x)).sort((a, b) => a.clientName.localeCompare(b.clientName))) console.log(show(c));

  if (!APPLY) return;
  let filed = 0;
  for (const c of fresh) {
    const r = await ca.createAsk({
      clientId: c.clientId, projectId: c.projectId, kind: c.kind, medium: c.medium, text: c.text, summary: c.summary, source: c.source, sourceRef: c.sourceRef,
      askedBy: c.askedBy, askedAt: c.askedAt, holdsDelivery: c.holdsDelivery, dedupeKey: c.dedupeKey, by: "Backfill (Oct 19 2026)",
    });
    if (r?.created) filed++;
  }
  console.log(`\nFiled ${filed}.`);
}
main()
  .then(async () => { const { prisma } = await import("@/lib/prisma"); await prisma.$disconnect(); })
  .catch((e) => { console.error(e); process.exit(1); });
