import "server-only";

import { prisma } from "@/lib/prisma";
import { clip, scrubMoney } from "@/lib/text";
import { etMonthDay } from "@/lib/datetime";
import { logJobEvent } from "./jobState";
import { ON_LISTING } from "./listingMatch";
import { LOT_LINES_LABEL } from "./lotLines";
import { HUB_EDIT, HUB_EDIT_LISTED } from "./photoEdit";
import { stagedCountWords, stagedPhotosOrdered } from "@/lib/stagingCount";

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
// with the line's `versionLabel` (the hub's Lot lines tool writes a hub
// version "Lot lines by <name>", lotLines.ts; a staging tool may write
// "Virtual staging …"; a later Straighten or upload of that photo replaces
// the picture, so it stops counting), or (b) Kyle confirms it by hand with a short note ("Lot lines
// added", for work done outside the hub), kept on the job's activity.
// Another add-on is one more line in ADD_ON_WORK.
//
// Oct 22 2026 (photo audit H6, M2):
//   · a version counts only while it IS the photo (its content hash is the
//     photo's current one): lot lines drawn and then replaced on the listing
//     (or by a later edit) no longer clear the hold;
//   · virtual staging clears by itself too: the fix runner's staging version
//     ("AutoHDR single_angle_staging"), or staged images already on the Aryeo
//     listing, as many as were ordered (Lot Lines the same way: 58 Recreation
//     Dr's lot lines went on as 3 separate "Lot Lines (n).jpg"). The order
//     line's DONE status is not read (addOnsOrdered says why).
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
  /** Oct 22 2026 (M2): other labels that carry the same work, each with its own sources (the fix runner's "AutoHDR single_angle_staging"). */
  moreLabels?: { label: string; sources: string[] }[];
  /** Oct 22 2026 (M2): a listing image named so ("Lot Lines (2).jpg", "Staged Living.jpg") is the work, already on the Aryeo listing. */
  listingName?: RegExp;
  /** Oct 22 2026 (M2): the classifier's "virtually staged" mark on a listing image counts too. */
  listingStaged?: boolean;
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
    // The contract with the Lot lines tool (lotLines.ts, hubFiles.saveLotLines):
    // a hub version labelled "Lot lines by <name>" (and the same picture once
    // it is on the listing, "Lot lines (on the Aryeo listing)"); an EDITOR
    // version labelled so counts too.
    versionLabel: LOT_LINES_LABEL,
    versionSources: [HUB_EDIT, HUB_EDIT_LISTED, "EDITOR"],
    listingName: /\b(lot|property|parcel|boundary)[\s_-]*lines?\b/i,
    words: /\b(lot|property|parcel|boundary)[\s-]*lines?\b|\bplats?\b|\bsurvey\b|\bacres?\b|\bacreage\b|\bparcels?\b|\bboundar(?:y|ies)\b|\blots?\s+\d|\bseparate lots?\b/i,
  },
  {
    key: "virtual_staging",
    need: "Virtual Staging needed",
    done: "Virtual staging added",
    product: /\b(virtual(?:ly)?|digital(?:ly)?)[\s-]*stag/i,
    types: ["VIRTUAL_STAGING"],
    versionLabel: "Virtual staging",
    // The fix runner's own label for AutoHDR's staging transform (fixRunner.ts: `AutoHDR ${transformName}`).
    moreLabels: [{ label: "AutoHDR single_angle_staging", sources: ["FIX"] }],
    listingName: /\bstag(?:ed|ing)\b|\bvirtual(?:ly)?[\s_-]*stag/i,
    listingStaged: true,
    words: /\bstag(?:e|ed|ing)\b|\bfurnish\w*|\bfurniture\b|\bempty rooms?\b|\bvacant\b/i,
  },
];

/** Does a version with this label and source carry this add-on's work? Pure. */
export function versionCarries(work: AddOnWork, v: { label: string; source: string }): boolean {
  const label = v.label.toLowerCase();
  if (label.startsWith(work.versionLabel.toLowerCase()) && (!work.versionSources?.length || work.versionSources.includes(v.source))) return true;
  return (work.moreLabels ?? []).some((m) => label.startsWith(m.label.toLowerCase()) && m.sources.includes(v.source));
}

export const ADD_ON_BY_KEY = new Map(ADD_ON_WORK.map((w) => [w.key, w]));

/**
 * Oct 28 2026 (Kyle on 40 N Perry St: "Virtual staging is also showing twice,
 * as it was in the order instructions and texted to us. If it's the same
 * request, then it should be combined into one"). Is a client's request (a
 * text, an email, an order note) the add-on itself, asked again? Only when it
 * names the add-on (staging, lot lines, a plat) and every other sentence in it
 * is about the same work or is a greeting: "Please stage the living room and
 * the den" is the staging; "Stage the den. And remove the trash cans" is not
 * (the trash cans would vanish under the staging line). The furniture words
 * alone never make it staging ("remove the furniture in photo 3"). Pure.
 */
const NAMES_ADD_ON: Record<AddOnKey, RegExp> = {
  lot_lines: /\b(lot|property|parcel|boundary)[\s-]*lines?\b|\bplats?\b/i,
  virtual_staging: /\b(virtual(?:ly)?|digital(?:ly)?)[\s-]*stag|\bstag(?:e|ed|ing)\b/i,
};
const GREETING = /^(hi|hey|hello|thanks|thank you|thx|ty|cheers|best|regards)\b[\s\w,!.]{0,30}$/i;
export function sameRequestAsAddOn(key: string, text: string): boolean {
  const work = ADD_ON_BY_KEY.get(key as AddOnKey);
  const names = NAMES_ADD_ON[key as AddOnKey];
  if (!work || !names) return false;
  const sentences = (text ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s && !GREETING.test(s));
  if (!sentences.some((s) => names.test(s))) return false;
  return sentences.every((s) => names.test(s) || work.words.test(s) || work.product.test(s));
}

/** The action prefix of Kyle's "Lot lines added" on the job's activity (the record the checklist reads). */
export const ADD_ON_CONFIRM_ACTION = "add-on confirmed";
/** How long the note with a confirmation must be. */
export const ADD_ON_NOTE_MIN = 5;

type OrderLine = { title: string; isCanceled?: boolean | null };
type DeliverableLine = { type: string; label: string | null; productTitle: string | null; removedFromOrderAt?: Date | null; waivedAt?: Date | null; status?: string | null; quantity?: number | null };

/**
 * The add-on work this order owes, with the order line that asks for it. Pure.
 * A live order item or deliverable asks for it; a deliverable for it that was
 * waived or pulled from the order (and nothing live for it) means it is not owed.
 * Oct 22 2026 (M2): `quantity`, how many were ordered (at least 1): that
 * many images of the work on the listing clear it. The deliverable's own DONE
 * status is NOT read: the hourly status sweep marks a staging line DONE as
 * soon as any photo is on the listing (projectStatus.expectedCategories puts
 * VIRTUAL_STAGING under PHOTOS), so it cannot tell staged from not staged.
 * Oct 23 2026 (Jordan): virtual staging is counted the one way every screen
 * counts it (stagingCount.ts): the line's quantity, or the number a custom
 * line's title states. `quantity` null = staging is on the order but no line
 * says how many: then staged images on the listing never clear it by
 * themselves (a staging version on a photo, or Kyle's confirmation, does),
 * and the line says the count is not on the order.
 */
export function addOnsOrdered(orderItems: (OrderLine & { quantity?: number | null })[], deliverables: DeliverableLine[]): { work: AddOnWork; line: string; quantity: number | null }[] {
  const out: { work: AddOnWork; line: string; quantity: number | null }[] = [];
  for (const work of ADD_ON_WORK) {
    if (work.key === "virtual_staging") {
      const s = stagedPhotosOrdered(orderItems, deliverables);
      if (!s.ordered) continue;
      const titles = [...new Set(s.lines.map((l) => l.title))].join(", ");
      out.push({ work, line: `${titles} (${stagedCountWords(s)})`, quantity: s.count });
      continue;
    }
    const titled = (d: DeliverableLine) => [d.productTitle, d.label].filter((x): x is string => !!x?.trim());
    const isIt = (d: DeliverableLine) => titled(d).some((t) => work.product.test(t)) || (titled(d).length === 0 && work.types.includes(d.type));
    const mine = deliverables.filter(isIt);
    const live = mine.filter((d) => !d.removedFromOrderAt && !d.waivedAt);
    const item = orderItems.find((i) => !i.isCanceled && work.product.test(i.title));
    const quantity = Math.max(1, live.reduce((s, d) => s + Math.max(1, d.quantity ?? 1), 0));
    if (live.length) out.push({ work, line: titled(live[0])[0] ?? item?.title ?? work.need.replace(/ needed$/, ""), quantity });
    else if (item && !mine.length) out.push({ work, line: item.title, quantity: 1 });
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
  /**
   * Cleared: a version on a photo in the delivery, or Kyle's confirmation by
   * hand. Oct 22 2026 (M2): "listing", the work already on the Aryeo listing
   * (photoName: the images).
   */
  cleared: { how: AddOnClearedHow; by: string | null; atISO: string; note: string | null; photoName: string | null } | null;
};
export type AddOnClearedHow = "version" | "confirmed" | "listing";

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

/**
 * The versions that carry each add-on's work, on photos in the delivery (or
 * already on the listing), by job and key. A hub picture (HUB_EDIT) made
 * after the add-on's own, of another kind (Straighten, an upload), replaced
 * it: every hub edit is drawn on the photo's own file, so the lines are gone
 * from that photo and it no longer counts (Oct 22 2026, photoEdit.editBaseOf).
 */
async function versionsOf(jobIds: string[]): Promise<Map<string, Map<AddOnKey, { at: Date; by: string | null; photoName: string }>>> {
  const out = new Map<string, Map<AddOnKey, { at: Date; by: string | null; photoName: string }>>();
  if (!jobIds.length) return out;
  const rows = await prisma.photoVersion.findMany({
    where: {
      photo: { jobId: { in: jobIds }, status: { in: ["ACTIVE", ON_LISTING] } },
      OR: [
        ...ADD_ON_WORK.map((w) => ({ label: { startsWith: w.versionLabel, mode: "insensitive" as const }, ...(w.versionSources?.length ? { source: { in: w.versionSources } } : {}) })),
        ...ADD_ON_WORK.flatMap((w) => (w.moreLabels ?? []).map((m) => ({ label: { startsWith: m.label, mode: "insensitive" as const }, source: { in: m.sources } }))),
        { source: HUB_EDIT },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { photoId: true, label: true, source: true, createdAt: true, createdBy: true, contentHash: true, autohdrVersionUuid: true, photo: { select: { jobId: true, name: true, contentHash: true, autohdrVersionUuid: true } } },
    take: 600,
  });
  const workOf = (v: { label: string; source: string }) => ADD_ON_WORK.find((w) => versionCarries(w, v));
  // The newest hub picture of each photo (rows are newest first).
  const newestHub = new Map<string, (typeof rows)[number]>();
  for (const v of rows) if (v.source === HUB_EDIT && !newestHub.has(v.photoId)) newestHub.set(v.photoId, v);
  for (const v of rows) {
    const work = workOf(v);
    if (!work) continue;
    // Oct 22 2026 (photo audit H6): the version counts only while it is the
    // photo's current picture. Lot lines replaced on the listing (a "Replaced"
    // version), or a later edit, mean the lines are gone from the photo.
    if (!isCurrentVersion(v, v.photo)) continue;
    const later = newestHub.get(v.photoId);
    if (v.source === HUB_EDIT && later && later !== v && workOf(later)?.key !== work.key) continue;
    const m = out.get(v.photo.jobId) ?? new Map();
    if (!m.has(work.key)) m.set(work.key, { at: v.createdAt, by: v.createdBy, photoName: v.photo.name });
    out.set(v.photo.jobId, m);
  }
  return out;
}

/**
 * Is this version the photo's current picture? (pure; photo audit H6) Its
 * content hash is the photo's, or (an AutoHDR fix, whose hash the hub keeps as
 * the AutoHDR version) its AutoHDR version is the photo's current one.
 */
export function isCurrentVersion(v: { contentHash: string | null; autohdrVersionUuid?: string | null }, photo: { contentHash: string | null; autohdrVersionUuid?: string | null }): boolean {
  if (v.contentHash && photo.contentHash) return v.contentHash === photo.contentHash;
  return !!v.autohdrVersionUuid && v.autohdrVersionUuid === photo.autohdrVersionUuid;
}

/**
 * Oct 22 2026 (photo audit M2): the add-on work already on the Aryeo listing:
 * listing images (read from the listing, or a split job's delivered photos)
 * named for it ("Lot Lines (2).jpg") or, for staging, marked virtually staged
 * by the classifier. By job and key: how many, and their names.
 */
async function listedWorkOf(jobIds: string[]): Promise<Map<string, Map<AddOnKey, { n: number; names: string[]; at: Date }>>> {
  const out = new Map<string, Map<AddOnKey, { n: number; names: string[]; at: Date }>>();
  if (!jobIds.length || !ADD_ON_WORK.some((w) => w.listingName || w.listingStaged)) return out;
  const rows = await prisma.photoAsset.findMany({
    where: { jobId: { in: jobIds }, OR: [{ status: ON_LISTING }, { status: "ACTIVE", sourceKind: "ARYEO" }] },
    select: { jobId: true, name: true, isVirtuallyStaged: true, updatedAt: true },
    take: 2000,
  });
  for (const r of rows) {
    for (const w of ADD_ON_WORK) {
      if (!((w.listingName && w.listingName.test(r.name)) || (w.listingStaged && r.isVirtuallyStaged))) continue;
      const m = out.get(r.jobId) ?? new Map();
      const cur = m.get(w.key) ?? { n: 0, names: [], at: r.updatedAt };
      cur.n++;
      cur.names.push(r.name);
      if (r.updatedAt > cur.at) cur.at = r.updatedAt;
      m.set(w.key, cur);
      out.set(r.jobId, m);
    }
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
      orderItems: { select: { title: true, isCanceled: true, quantity: true } },
      deliverables: { select: { type: true, label: true, productTitle: true, removedFromOrderAt: true, waivedAt: true, quantity: true } },
      appointments: { orderBy: { startAt: "asc" }, select: { description: true } },
    },
  });
  if (!p) return [];
  const ordered = addOnsOrdered(p.orderItems, p.deliverables);
  if (!ordered.length) return [];
  const [{ cleanBrief, parseShootBrief }, { ASK_SOURCES, sourceWords }, confirmed, versions, listed, asks] = await Promise.all([
    import("@/lib/shoot"),
    import("@/lib/clientAsks"),
    confirmationsOf([jobId]),
    versionsOf([jobId]),
    listedWorkOf([jobId]),
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
  const mineListed = listed.get(jobId);
  return ordered.map(({ work, line, quantity }) => {
    const v = mineVersions?.get(work.key);
    const c = mineConfirmed?.get(work.key);
    // Oct 22 2026 (M2): already on the Aryeo listing, as many images of it as were ordered.
    const l = mineListed?.get(work.key);
    // Oct 23 2026: a staging order that does not say how many is never cleared by a count.
    const onListing = l && quantity != null && l.n >= quantity ? l : null;
    // The newest of them decides what the line says; any clears it (on a tie, the first listed: a version, then a person's confirmation).
    const options: NonNullable<AddOnState["cleared"]>[] = [
      ...(v ? [{ how: "version" as const, by: v.by, atISO: v.at.toISOString(), note: null, photoName: v.photoName }] : []),
      ...(c ? [{ how: "confirmed" as const, by: c.by, atISO: c.at.toISOString(), note: c.note, photoName: null }] : []),
      ...(onListing ? [{ how: "listing" as const, by: null, atISO: onListing.at.toISOString(), note: null, photoName: clip(onListing.names.join(", "), 120) }] : []),
    ];
    const cleared: AddOnState["cleared"] = options.length ? options.reduce((best, o) => (Date.parse(o.atISO) > Date.parse(best.atISO) ? o : best)) : null;
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
        orderItems: { select: { title: true, isCanceled: true, quantity: true } },
        deliverables: { select: { type: true, label: true, productTitle: true, removedFromOrderAt: true, waivedAt: true, quantity: true } },
      },
    }),
    prisma.photoJob.findMany({ where: { projectId: { in: ids } }, select: { id: true, projectId: true, stage: true } }),
  ]);
  const owing = projects.map((p) => ({ id: p.id, ordered: addOnsOrdered(p.orderItems, p.deliverables) })).filter((p) => p.ordered.length);
  if (!owing.length) return out;
  const jobOf = new Map(jobs.map((j) => [j.projectId, j]));
  const jobIds = owing.map((p) => jobOf.get(p.id)?.id).filter((x): x is string => !!x);
  const [confirmed, versions, listed] = await Promise.all([confirmationsOf(jobIds), versionsOf(jobIds), listedWorkOf(jobIds)]);
  for (const p of owing) {
    const job = jobOf.get(p.id);
    // Photos already out: nothing to hold any more.
    if (job?.stage === "DELIVERED") continue;
    const onListing = (key: AddOnKey, n: number | null) => n != null && (listed.get(job?.id ?? "")?.get(key)?.n ?? 0) >= n;
    const open = p.ordered.filter((o) => !job || (!confirmed.get(job.id)?.has(o.work.key) && !versions.get(job.id)?.has(o.work.key) && !onListing(o.work.key, o.quantity))).map((o) => o.work.need);
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
