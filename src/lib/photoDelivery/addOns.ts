import "server-only";

import { prisma } from "@/lib/prisma";
import { clip, scrubMoney } from "@/lib/text";
import { etMonthDay } from "@/lib/datetime";
import { logJobEvent } from "./jobState";
import { ON_LISTING } from "./listingMatch";

// ---------------------------------------------------------------------------
// ADD-ON WORK THAT MUST BE CONFIRMED BEFORE THE PHOTOS GO OUT (Oct 22 2026).
//
// Jordan on Brandon's shoot (58 Recreation Dr, Jim Thorpe: "Lot Lines" +
// "Drone Aerial Photography"): "it should be clearer if a client requested lot
// lines, and we should hold the delivery until lot lines are confirmed added.
// It should say Lot Lines needed, and then add any wording underneath from the
// agent." Then: "Should do the same thing for virtual staging."
//
// ONE LIST (ADD_ON_WORK): each line is an order item that is done by hand on
// the finished photos, read off the order (an Aryeo order line, or the job's
// deliverable for it). While the job has one that is not confirmed:
//   · the photo job shows "Lot Lines needed" with the agent's own words under
//     it (the order notes and order questions, the client's texts and emails
//     about the job, the photographer's wrap-up);
//   · it is a HOLD line on the delivery checklist (delivery.ts): Approve and
//     deliver waits for it, shadow mode or not;
//   · the hub's own same-day approval never goes past it (personOnly): a job
//     with lot lines or staging is always Kyle's to approve.
// It clears when (a) a photo in the delivery has a version whose label starts
// with the line's `versionLabel` (the hub's Lot lines drawing tool writes
// "Lot lines …" as an EDITOR version; a staging tool may write "Virtual
// staging …"), or (b) Kyle confirms it by hand with a short note ("Lot lines
// added", for work done outside the hub), kept on the job's activity.
// Another add-on is one more line in ADD_ON_WORK.
// ---------------------------------------------------------------------------

export type AddOnKey = "lot_lines" | "virtual_staging";

export type AddOnWork = {
  key: AddOnKey;
  /** "Lot Lines needed": the hold line's words. */
  need: string;
  /** "Lot lines added": the confirm button, and the line once it is cleared. */
  done: string;
  /** The order line (an Aryeo order item title, or a deliverable's product title or label). */
  product: RegExp;
  /** A deliverable of this type with no product title or label of its own counts too. */
  types: string[];
  /** A photo version whose label starts with this (any case) means the work is on the photos. */
  versionLabel: string;
  /** Only versions from these sources count (none listed: any source). */
  versionSources?: string[];
  /** The agent's sentences about it (order notes, questions, texts, the wrap-up). */
  words: RegExp;
};

export const ADD_ON_WORK: readonly AddOnWork[] = [
  {
    key: "lot_lines",
    need: "Lot Lines needed",
    done: "Lot lines added",
    product: /\b(lot|property|parcel|boundary)[\s-]*lines?\b/i,
    types: [],
    // The contract with the Lot lines drawing tool (Oct 22 2026): an EDITOR version labelled "Lot lines …".
    versionLabel: "Lot lines",
    versionSources: ["EDITOR"],
    words: /\b(lot|property|parcel|boundary)[\s-]*lines?\b|\bplats?\b|\bsurvey\b|\bacres?\b|\bacreage\b|\bparcels?\b|\bboundar(?:y|ies)\b|\blots?\s+\d|\bseparate lots?\b/i,
  },
  {
    key: "virtual_staging",
    need: "Virtual Staging needed",
    done: "Virtual staging added",
    product: /\b(virtual(?:ly)?|digital(?:ly)?)[\s-]*stag/i,
    types: ["VIRTUAL_STAGING"],
    versionLabel: "Virtual staging",
    words: /\bstag(?:e|ed|ing)\b|\bfurnish\w*|\bfurniture\b|\bempty rooms?\b|\bvacant\b/i,
  },
];

export const ADD_ON_BY_KEY = new Map(ADD_ON_WORK.map((w) => [w.key, w]));

/** The action prefix of Kyle's "Lot lines added" on the job's activity (the record the checklist reads). */
export const ADD_ON_CONFIRM_ACTION = "add-on confirmed";
/** How long the note with a confirmation must be. */
export const ADD_ON_NOTE_MIN = 5;

type OrderLine = { title: string; isCanceled?: boolean | null };
type DeliverableLine = { type: string; label: string | null; productTitle: string | null; removedFromOrderAt?: Date | null; waivedAt?: Date | null };

/**
 * The add-on work this order owes, with the order line that asks for it. Pure.
 * A live order item or deliverable asks for it; a deliverable for it that was
 * waived or pulled from the order (and nothing live for it) means it is not owed.
 */
export function addOnsOrdered(orderItems: OrderLine[], deliverables: DeliverableLine[]): { work: AddOnWork; line: string }[] {
  const out: { work: AddOnWork; line: string }[] = [];
  for (const work of ADD_ON_WORK) {
    const titled = (d: DeliverableLine) => [d.productTitle, d.label].filter((x): x is string => !!x?.trim());
    const isIt = (d: DeliverableLine) => titled(d).some((t) => work.product.test(t)) || (titled(d).length === 0 && work.types.includes(d.type));
    const mine = deliverables.filter(isIt);
    const live = mine.filter((d) => !d.removedFromOrderAt && !d.waivedAt);
    const item = orderItems.find((i) => !i.isCanceled && work.product.test(i.title));
    if (live.length) out.push({ work, line: titled(live[0])[0] ?? item?.title ?? work.need.replace(/ needed$/, "") });
    else if (item && !mine.length) out.push({ work, line: item.title });
  }
  return out;
}

export type AddOnQuote = { from: string; text: string };

/** "Order notes", "Order question: Lot line details", "Text from Brandon, Oct 21", "Harrison's wrap-up". */
type WordSource = { from: string; text: string | null | undefined };

/**
 * The agent's own words about this add-on, from every place they could have
 * written them (Pure). Whole sentences that name it, money scrubbed (Kyle's
 * screen), the same words once, at most five. A question whose name is about
 * it is taken whole.
 */
export function addOnQuotes(work: AddOnWork, sources: (WordSource & { whole?: boolean })[]): AddOnQuote[] {
  const out: AddOnQuote[] = [];
  const seen = new Set<string>();
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const s of sources) {
    const raw = (s.text ?? "").replace(/\s+/g, " ").trim();
    if (!raw || /^n\/?a\.?$/i.test(raw)) continue;
    const sentences = s.whole ? [raw] : raw.split(/(?<=[.!?])\s+|\s*\n+\s*/).filter((x) => work.words.test(x) || work.product.test(x));
    const text = scrubMoney(clip(sentences.join(" ").trim(), 300));
    if (!text) continue;
    const k = norm(text);
    if (seen.has(k) || [...seen].some((x) => x.includes(k))) continue;
    seen.add(k);
    out.push({ from: s.from, text });
    if (out.length >= 5) break;
  }
  return out;
}

export type AddOnState = {
  key: AddOnKey;
  need: string;
  done: string;
  /** The order line that asks for it ("Lot Lines"). */
  ordered: string;
  quotes: AddOnQuote[];
  /** Cleared: a version on a photo in the delivery, or Kyle's confirmation by hand. */
  cleared: { how: "version" | "confirmed"; by: string | null; atISO: string; note: string | null; photoName: string | null } | null;
};

const firstName = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || null;

/** The newest confirmation by hand of each add-on on a job (PhotoJobEvent), by key. */
async function confirmationsOf(jobIds: string[]): Promise<Map<string, Map<AddOnKey, { by: string; at: Date; note: string | null }>>> {
  const out = new Map<string, Map<AddOnKey, { by: string; at: Date; note: string | null }>>();
  if (!jobIds.length) return out;
  const rows = await prisma.photoJobEvent.findMany({
    where: { jobId: { in: jobIds }, action: { startsWith: ADD_ON_CONFIRM_ACTION } },
    orderBy: { at: "desc" },
    select: { jobId: true, actor: true, at: true, dataJson: true },
    take: 400,
  });
  for (const r of rows) {
    let d: { addOn?: unknown; note?: unknown } = {};
    try {
      d = JSON.parse(r.dataJson ?? "{}") as typeof d;
    } catch { /* an unreadable row confirms nothing */ }
    const key = typeof d.addOn === "string" && ADD_ON_BY_KEY.has(d.addOn as AddOnKey) ? (d.addOn as AddOnKey) : null;
    if (!key) continue;
    const m = out.get(r.jobId) ?? new Map();
    if (!m.has(key)) m.set(key, { by: r.actor, at: r.at, note: typeof d.note === "string" ? d.note : null });
    out.set(r.jobId, m);
  }
  return out;
}

/** The versions that carry each add-on's work, on photos in the delivery (or already on the listing), by job and key. */
async function versionsOf(jobIds: string[]): Promise<Map<string, Map<AddOnKey, { at: Date; by: string | null; photoName: string }>>> {
  const out = new Map<string, Map<AddOnKey, { at: Date; by: string | null; photoName: string }>>();
  if (!jobIds.length) return out;
  const rows = await prisma.photoVersion.findMany({
    where: {
      photo: { jobId: { in: jobIds }, status: { in: ["ACTIVE", ON_LISTING] } },
      OR: ADD_ON_WORK.map((w) => ({ label: { startsWith: w.versionLabel, mode: "insensitive" as const }, ...(w.versionSources?.length ? { source: { in: w.versionSources } } : {}) })),
    },
    orderBy: { createdAt: "desc" },
    select: { label: true, source: true, createdAt: true, createdBy: true, photo: { select: { jobId: true, name: true } } },
    take: 400,
  });
  for (const v of rows) {
    const work = ADD_ON_WORK.find((w) => v.label.toLowerCase().startsWith(w.versionLabel.toLowerCase()) && (!w.versionSources?.length || w.versionSources.includes(v.source)));
    if (!work) continue;
    const m = out.get(v.photo.jobId) ?? new Map();
    if (!m.has(work.key)) m.set(work.key, { at: v.createdAt, by: v.createdBy, photoName: v.photo.name });
    out.set(v.photo.jobId, m);
  }
  return out;
}

/**
 * The add-on work on this job's order and where each stands, with the agent's
 * words. Empty when the order has none. Read-only.
 */
export async function addOnStates(projectId: string, jobId: string): Promise<AddOnState[]> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      removalNotes: true, shotOrderNotes: true, editorBrief: true,
      photographer: { select: { name: true } },
      orderItems: { select: { title: true, isCanceled: true } },
      deliverables: { select: { type: true, label: true, productTitle: true, removedFromOrderAt: true, waivedAt: true } },
      appointments: { orderBy: { startAt: "asc" }, select: { description: true } },
    },
  });
  if (!p) return [];
  const ordered = addOnsOrdered(p.orderItems, p.deliverables);
  if (!ordered.length) return [];
  const [{ cleanBrief, parseShootBrief }, { ASK_SOURCES, sourceWords }, confirmed, versions, asks] = await Promise.all([
    import("@/lib/shoot"),
    import("@/lib/clientAsks"),
    confirmationsOf([jobId]),
    versionsOf([jobId]),
    prisma.clientAsk.findMany({ where: { projectId }, orderBy: { askedAt: "asc" }, take: 40, select: { text: true, source: true, askedBy: true, askedAt: true } }),
  ]);
  // Every place the agent (or the photographer) could have said how they want it.
  const sources: (WordSource & { whole?: boolean })[] = [];
  for (const a of p.appointments) {
    const b = a.description ? parseShootBrief(cleanBrief(a.description)) : null;
    if (!b) continue;
    sources.push({ from: "Order notes", text: b.orderNotes }, { from: "Special instructions", text: b.special });
    for (const q of b.extra) sources.push({ from: `Order question: ${clip(q.label, 60)}`, text: q.value, whole: ordered.some((o) => o.work.words.test(q.label) || o.work.product.test(q.label)) });
  }
  for (const a of asks) {
    if (!ASK_SOURCES.includes(a.source)) continue; // order notes and the wrap-up are read above, at the source
    sources.push({ from: `${sourceWords(a.source)} from ${firstName(a.askedBy) ?? "the client"}, ${etMonthDay(a.askedAt)}`, text: a.text });
  }
  const who = firstName(p.photographer?.name);
  const wrap = `${who ? `${who}'s` : "The photographer's"} wrap-up`;
  sources.push({ from: wrap, text: p.editorBrief }, { from: wrap, text: p.removalNotes }, { from: wrap, text: p.shotOrderNotes });
  const mineConfirmed = confirmed.get(jobId);
  const mineVersions = versions.get(jobId);
  return ordered.map(({ work, line }) => {
    const v = mineVersions?.get(work.key);
    const c = mineConfirmed?.get(work.key);
    // The newer of the two decides what the line says; either clears it.
    const cleared: AddOnState["cleared"] =
      v && (!c || v.at >= c.at)
        ? { how: "version", by: v.by, atISO: v.at.toISOString(), note: null, photoName: v.photoName }
        : c
          ? { how: "confirmed", by: c.by, atISO: c.at.toISOString(), note: c.note, photoName: null }
          : null;
    return { key: work.key, need: work.need, done: work.done, ordered: line, quotes: addOnQuotes(work, sources), cleared };
  });
}

/**
 * The add-on work still open on each project's photo job (for the boards: the
 * Photo Delivery card and the Shoots row), as their "… needed" words, in
 * ADD_ON_WORK order. Batched: four reads for any number of projects. A project
 * with nothing open is left out.
 */
export async function openAddOnsByProject(projectIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(projectIds)].filter(Boolean);
  if (!ids.length) return out;
  const [projects, jobs] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        orderItems: { select: { title: true, isCanceled: true } },
        deliverables: { select: { type: true, label: true, productTitle: true, removedFromOrderAt: true, waivedAt: true } },
      },
    }),
    prisma.photoJob.findMany({ where: { projectId: { in: ids } }, select: { id: true, projectId: true, stage: true } }),
  ]);
  const owing = projects.map((p) => ({ id: p.id, ordered: addOnsOrdered(p.orderItems, p.deliverables) })).filter((p) => p.ordered.length);
  if (!owing.length) return out;
  const jobOf = new Map(jobs.map((j) => [j.projectId, j]));
  const jobIds = owing.map((p) => jobOf.get(p.id)?.id).filter((x): x is string => !!x);
  const [confirmed, versions] = await Promise.all([confirmationsOf(jobIds), versionsOf(jobIds)]);
  for (const p of owing) {
    const job = jobOf.get(p.id);
    // Photos already out: nothing to hold any more.
    if (job?.stage === "DELIVERED") continue;
    const open = p.ordered.filter((o) => !job || (!confirmed.get(job.id)?.has(o.work.key) && !versions.get(job.id)?.has(o.work.key))).map((o) => o.work.need);
    if (open.length) out.set(p.id, open);
  }
  return out;
}

/**
 * Kyle confirms an add-on was put on the photos outside the hub ("Lot lines
 * added"), with a short note: what was added and where. Goes on the job's
 * activity (the record the checklist reads) and the project's timeline.
 */
export async function confirmAddOn(jobId: string, key: string, note: string, by: string): Promise<{ ok: boolean; message: string }> {
  const work = ADD_ON_BY_KEY.get(key as AddOnKey);
  if (!work) return { ok: false, message: "That add-on is not one the hub knows." };
  const why = (note ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (why.length < ADD_ON_NOTE_MIN) return { ok: false, message: `Write a short note: what was added, and on which photos (at least ${ADD_ON_NOTE_MIN} characters).` };
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true } });
  if (!job) return { ok: false, message: "That photo job no longer exists." };
  const states = await addOnStates(job.projectId, jobId);
  const st = states.find((s) => s.key === work.key);
  if (!st) return { ok: false, message: `This order has no ${work.need.replace(/ needed$/, "")} on it. Reload the page.` };
  const who = by.trim().slice(0, 120) || "staff";
  await logJobEvent(jobId, who, `${ADD_ON_CONFIRM_ACTION}: ${work.done}: ${why}`, { addOn: work.key, note: why });
  await prisma.activity.create({ data: { projectId: job.projectId, type: "SYSTEM", body: clip(`${work.done} (confirmed by ${who}): ${why}`, 600) } }).catch(() => {});
  return { ok: true, message: `Saved: ${work.done.toLowerCase()}. It no longer holds the delivery; your note is on the job's activity.` };
}
