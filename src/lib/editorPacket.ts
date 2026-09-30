import "server-only";
import crypto from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { EDITORS, pinnedEditorFor, type EditorKey } from "@/lib/editors";
import { stripMoneySentences } from "@/lib/text";
import { etDateTime } from "@/lib/datetime";
import type { OutputBrief, ScriptDirection } from "@/lib/deliverableOutputs";

// ===========================================================================
// THE OUTSIDE AGENCY'S PACKET, AND PROOF IT WENT (unified handoff §7.7 / A33 /
// O08, Sep 25 2026).
//
// Jordan, Sep 25: "Im building for all in house, but we do work with Luma
// visuals and I have certain video projects that I reassign to them right now
// as external agency." So the agency is ACTIVE, and it is the existing
// `external_agency` pin (editors.ts names it Luma Visuals) — not the retired
// `luma` key, whose automatic premium lane ended in August and stays retired.
//
// What existed: an ADMIN bell, "send them the footage and the brief". Nothing
// recorded WHAT was sent, to whom, when, by whom, or whether Luma ever said
// they had it — so a job handed to Luma was indistinguishable from one
// forgotten in a Dropbox folder. A file in Dropbox, a task label or a bell is
// not dispatch evidence (§7.7).
//
// What this is:
//   · buildEditorPacket — the packet, built from what the hub already holds
//     (each video's brief from deliverableOutputs.outputBriefsFor, the job's
//     instructions, the brand kit, the music pick, the folders, open revision
//     asks, the export spec) plus WHAT IS MISSING, said plainly. Money-scrubbed
//     end to end: it leaves the building. Its fingerprint (sha256 over a
//     canonical serialisation) changes exactly when its content does.
//   · recordEditorDispatch — the office's own record of a send: the packet
//     FROZEN as it was (manifestJson + hash + the missing list), the recipient
//     and channel the office typed (no Luma contact is on file, and nothing
//     here guesses one), who recorded it and when. Each send is the next
//     version; the one before is marked superseded. The same packet to the
//     same place twice is one record, not two.
//   · recordEditorAcknowledgment — Luma saying they have it: who, how, when,
//     and who in the office recorded it. Once per version.
//   · editorDispatchState — Not sent / Sent vN, not acknowledged /
//     Acknowledged / Out of date (the brief changed after it was sent).
//
// WHAT IT NEVER DOES: send anything. There is no email, no upload, no API
// call to Luma. The office sends the packet the way it always has and records
// it here. A future automatic send would be a new switch, OFF, and Jordan's
// explicit approval of the recipient.
// ===========================================================================

/** The pin a job carries when it is handed to the outside agency. */
export const PACKET_VENDOR_KEY: EditorKey = "external_agency";
export const vendorName = (): string => EDITORS[PACKET_VENDOR_KEY].name;

export const DISPATCH_CHANNELS = ["email", "portal", "dropbox", "text", "phone", "other"] as const;
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];
export const DISPATCH_CHANNEL_LABEL: Record<DispatchChannel, string> = {
  email: "Email",
  portal: "Their portal",
  dropbox: "Dropbox link",
  text: "Text",
  phone: "Phone call",
  other: "Other",
};
export const ACK_SOURCES = ["email", "portal", "text", "phone", "in_person", "other"] as const;
export type AckSource = (typeof ACK_SOURCES)[number];
export const ACK_SOURCE_LABEL: Record<AckSource, string> = {
  email: "by email",
  portal: "in their portal",
  text: "by text",
  phone: "on a call",
  in_person: "in person",
  other: "another way",
};

export type PacketGap = { key: string; label: string; owner: "photographer" | "office" | "client" };

export type PacketVideo = {
  outputId: string;
  index: number;
  label: string;
  format: string;
  briefVersion: number | null;
  versionLabel: string;
  directionSource: OutputBrief["directionSource"];
  sections: { label: string; text: string }[];
  /** Added after schema 1 packets existed; absent in a frozen historical send. */
  brandChoice?: string;
  topicTitle: string | null;
  note: string | null;
  script: { title: string; versionNo: number | null; standing: string; text: string | null; direction: ScriptDirection | null } | null;
  rawFolder: string | null;
  dueISO: string | null;
};

export type PacketManifest = {
  schema: 1;
  project: { id: string; title: string; street: string; client: string; packageName: string | null; shootDateISO: string | null };
  vendor: { key: string; name: string };
  videos: PacketVideo[];
  job: {
    instructions: string | null;
    photographerNotes: string | null;
    scriptStatus: string | null;
    studioScript: string | null;
    specialRequests: string[];
    customerNote: string | null;
    videosFilmed: number | null;
  };
  music: { line: string; file: string | null } | null;
  brand: { colors: string[]; fonts: string | null; files: string[]; music: string | null; defaults: string[]; preferences: string[] } | null;
  folders: { rawVideo: string; finalVideo: string };
  revisionAsks: string[];
  exportSpec: string[];
};

export type EditorPacket = { manifest: PacketManifest; hash: string; missing: PacketGap[]; json: string };

/** JSON with every object's keys sorted, so equal content hashes equally. */
function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object" && !(x instanceof Date)) {
      return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}
export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

const scrub = (s: string | null | undefined): string | null => {
  const t = stripMoneySentences((s ?? "").trim()).trim();
  return t || null;
};

/**
 * The packet as it would go out NOW, with what is missing. Null when the
 * project does not exist. Read-only; no provider call (the folder paths are
 * the hub's record of them, not a Dropbox read).
 */
export async function buildEditorPacket(projectId: string): Promise<EditorPacket | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, addressLine: true, packageName: true, shootDate: true, createdAt: true, dropboxFolder: true,
      contentMonthId: true, videoInstructions: true, editorBrief: true, scriptConfirmNote: true, scriptConfirmedAt: true,
      reelScript: true, reelHook: true, videosFilmed: true, debriefSubmittedAt: true, editSpec: true, statusEvidence: true,
      // O05: the edit waits on the VIDEO half's own handoff, as the edit card does.
      videoHandoffAt: true,
      deliveryDue: true, dueOverrideAt: true, promisedDueAt: true,
      client: { select: { id: true, name: true, generalNotes: true, editingPreferences: true } },
      photographer: { select: { name: true } },
      // Live lines and owed rows only, with the style stamp (§7.4): the SAME
      // inputs the edit card's readiness reads (tasks.handoffReadinessOf), so a
      // canceled premium line or a split submission cannot freeze a gap into a
      // sent version that no other screen shows (review, Sep 25).
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      deliverables: {
        where: { removedFromOrderAt: null, waivedAt: null },
        select: { type: true, label: true, productTitle: true, videoStyle: true, notCompletedReason: true },
      },
      activities: { where: { type: "SPECIAL_REQUEST" }, orderBy: { createdAt: "asc" }, select: { body: true } },
    },
  });
  if (!p) return null;

  const [{ outputBriefsFor }, { actualFolderPaths }, { readMusicPick, musicPickLine }, { creativeCustomerNote }, { EXPORT_SPEC_LINES }, { videoLaneRevisionWhere }] =
    await Promise.all([
      import("@/lib/deliverableOutputs"),
      import("@/lib/dropboxFolders"),
      import("@/lib/musicPick"),
      import("@/lib/clientNotes"),
      import("@/lib/videoStyles"),
      import("@/lib/reviewCuts"),
    ]);
  const [outputs, brand, revisions] = await Promise.all([
    outputBriefsFor(projectId, { scrub: true }).catch(() => [] as OutputBrief[]),
    import("@/lib/brandProfile").then((m) => m.brandBriefFor(p.client.id, { projectId, scrub: true, links: false })).catch(() => null),
    prisma.smartTask
      .findMany({ where: videoLaneRevisionWhere(projectId), orderBy: { createdAt: "asc" }, select: { description: true, summary: true } })
      .catch(() => [] as { description: string | null; summary: string | null }[]),
  ]);
  const folders = actualFolderPaths({ title: p.title, addressLine: p.addressLine, shootDate: p.shootDate, createdAt: p.createdAt, client: { name: p.client.name }, dropboxFolder: p.dropboxFolder });
  const music = readMusicPick(p.editSpec);

  const videos: PacketVideo[] = outputs.map((o) => ({
    outputId: o.outputId,
    index: o.index,
    label: o.label,
    format: o.format,
    briefVersion: o.version,
    versionLabel: o.versionLabel,
    directionSource: o.directionSource,
    sections: o.sections.map((x) => ({ label: x.label, text: x.text })),
    brandChoice: o.brandAsset ? `${o.brandAsset.name}${o.brandAsset.versionNo ? ` v${o.brandAsset.versionNo}` : ""}${o.brandAsset.fileName ? ` · ${o.brandAsset.fileName}` : ""}${o.brandAsset.state !== "current" ? " · no longer current; confirm with Kyle" : ""}` : "No logo or branding card chosen for this video",
    topicTitle: o.topicTitle,
    note: o.note,
    script: o.script
      ? { title: o.script.title, versionNo: o.script.versionNo, standing: o.script.standing, text: o.script.text, direction: o.script.direction }
      : null,
    rawFolder: o.folder ? o.folder.path : null,
    dueISO: o.promisedAtISO,
  }));

  const manifest: PacketManifest = {
    schema: 1,
    project: {
      id: p.id,
      title: p.title,
      street: (p.title || "").split(",")[0].trim() || p.title,
      client: p.client.name,
      packageName: p.packageName,
      shootDateISO: p.shootDate?.toISOString() ?? null,
    },
    vendor: { key: PACKET_VENDOR_KEY, name: vendorName() },
    videos,
    job: {
      instructions: scrub(p.videoInstructions),
      photographerNotes: scrub(p.editorBrief),
      scriptStatus: scrub(p.scriptConfirmNote),
      studioScript: scrub([p.reelHook, p.reelScript].filter(Boolean).join("\n\n")),
      specialRequests: p.activities.map((a) => scrub(a.body)).filter((x): x is string => !!x),
      customerNote: scrub(creativeCustomerNote(p.client)),
      videosFilmed: p.videosFilmed,
    },
    music: music ? { line: musicPickLine(music), file: music.dropboxPath ?? null } : null,
    brand: brand
      ? {
          colors: brand.colors,
          fonts: brand.fontNames,
          files: brand.files.map((f) => `${f.typeWord}: ${f.name} (v${f.versionNo})`),
          music: brand.music,
          defaults: brand.productionDefaults.map((d) => `${d.name}: ${d.text}`),
          preferences: brand.acceptedPreferences,
        }
      : null,
    folders: { rawVideo: folders.rawVideo, finalVideo: folders.finalVideo },
    revisionAsks: revisions
      .flatMap((t) => (t.description ?? t.summary ?? "").split(/\n\nNew request: /))
      .map((x) => scrub(x))
      .filter((x): x is string => !!x),
    exportSpec: [...EXPORT_SPEC_LINES],
  };

  // ---- WHAT IS MISSING, said plainly ---------------------------------------
  const missing: PacketGap[] = [];
  // 1. The photographer's handoff (the same pure rule the edit card uses — O01).
  const { handoffReadinessOf } = await import("@/lib/tasks");
  const ready = await handoffReadinessOf(p);
  for (const g of ready.gaps) missing.push({ key: `handoff:${g.key}`, label: `${g.label[0].toUpperCase()}${g.label.slice(1)}`, owner: g.owedBy });
  // 2. The footage. An unread folder is UNKNOWN, not empty (§7.3).
  let dropbox: { rawVideo?: number; stale?: boolean } | null | undefined;
  try {
    dropbox = p.statusEvidence ? (JSON.parse(p.statusEvidence) as { dropbox?: { rawVideo?: number; stale?: boolean } | null }).dropbox : undefined;
  } catch {
    dropbox = undefined;
  }
  if (!dropbox || dropbox.stale) missing.push({ key: "raws:unknown", label: "Raw footage not confirmed: the job's folder has not been read recently", owner: "office" });
  else if (!(dropbox.rawVideo && dropbox.rawVideo > 0)) missing.push({ key: "raws:none", label: "No raw video in 02-RAW-Video yet", owner: "photographer" });
  // 3. Each video's own gaps.
  if (videos.length === 0) missing.push({ key: "videos:none", label: "No owed video is recorded on this job", owner: "office" });
  for (const v of videos) {
    if (videos.length > 1 && v.directionSource === "none") missing.push({ key: `video:${v.outputId}:direction`, label: `${v.label}: no instructions for this video`, owner: "office" });
    if (p.contentMonthId) {
      if (!v.topicTitle) missing.push({ key: `video:${v.outputId}:topic`, label: `${v.label}: no topic recorded`, owner: "photographer" });
      else if (!v.script) missing.push({ key: `video:${v.outputId}:script`, label: `${v.label}: no script on file`, owner: "office" });
      else if (!/approved by the client/.test(v.script.standing)) missing.push({ key: `video:${v.outputId}:script-approval`, label: `${v.label}: script not approved by the client yet`, owner: "client" });
    }
  }
  // 4. A date to deliver against.
  if (!p.deliveryDue && !p.dueOverrideAt && !p.promisedDueAt && !videos.some((v) => v.dueISO)) {
    missing.push({ key: "due", label: "No delivery date on the job", owner: "office" });
  }

  const json = canonicalJson(manifest);
  return { manifest, hash: sha256(json), missing, json };
}

// ---- the record ------------------------------------------------------------

/** Is this job handed to the outside agency right now? The pin, or an open edit task on its key. */
export async function isHandedToAgency(projectId: string): Promise<boolean> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { editorManual: true, editorVendorKey: true, editor: { select: { name: true } } },
  });
  if (!p) return false;
  if (pinnedEditorFor(p).key === PACKET_VENDOR_KEY) return true;
  const task = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "edit_video", assignedKey: PACKET_VENDOR_KEY, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  return !!task;
}

export type DispatchView = {
  id: string;
  version: number;
  recipient: string;
  channel: string;
  channelLabel: string;
  dispatchedAtISO: string;
  dispatchedBy: string;
  acknowledgedAtISO: string | null;
  acknowledgedBy: string | null;
  ackSource: string | null;
  superseded: boolean;
  packetHash: string;
  missing: PacketGap[];
};

type DispatchRow = {
  id: string; packetVersion: number; recipient: string; channel: string; dispatchedAt: Date; dispatchedBy: string;
  acknowledgedAt: Date | null; acknowledgedBy: string | null; ackSource: string | null; supersededById: string | null;
  packetHash: string; missingJson: string | null;
};

function viewOf(r: DispatchRow): DispatchView {
  let missing: PacketGap[] = [];
  try {
    missing = r.missingJson ? (JSON.parse(r.missingJson) as PacketGap[]) : [];
  } catch { /* an unreadable list reads as none recorded */ }
  return {
    id: r.id,
    version: r.packetVersion,
    recipient: r.recipient,
    channel: r.channel,
    channelLabel: DISPATCH_CHANNEL_LABEL[r.channel as DispatchChannel] ?? r.channel,
    dispatchedAtISO: r.dispatchedAt.toISOString(),
    dispatchedBy: r.dispatchedBy,
    acknowledgedAtISO: r.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: r.acknowledgedBy,
    ackSource: r.ackSource,
    superseded: !!r.supersededById,
    packetHash: r.packetHash,
    missing,
  };
}

const DISPATCH_SELECT = {
  id: true, packetVersion: true, recipient: true, channel: true, dispatchedAt: true, dispatchedBy: true,
  acknowledgedAt: true, acknowledgedBy: true, ackSource: true, supersededById: true, packetHash: true, missingJson: true,
} as const;

export type DispatchStatus = "not_sent" | "sent" | "acknowledged" | "out_of_date";

/** One sentence for a row or a card, from the newest record (and, when given, the live packet's hash). */
export function dispatchLine(latest: DispatchView | null, currentHash?: string | null): { status: DispatchStatus; line: string } {
  const name = vendorName();
  if (!latest) return { status: "not_sent", line: `Not sent to ${name} yet: record the send on the job page.` };
  if (currentHash && currentHash !== latest.packetHash) {
    return { status: "out_of_date", line: `The brief changed after v${latest.version} went to ${name}: send v${latest.version + 1}.` };
  }
  if (latest.acknowledgedAtISO) {
    return { status: "acknowledged", line: `${name} acknowledged v${latest.version} (${latest.acknowledgedBy ?? "no name given"}, ${etDateTime(latest.acknowledgedAtISO)}).` };
  }
  return { status: "sent", line: `v${latest.version} sent to ${latest.recipient} ${etDateTime(latest.dispatchedAtISO)} by ${latest.dispatchedBy}: not acknowledged yet.` };
}

export type EditorDispatchState = {
  vendorKey: string;
  vendorName: string;
  handedOver: boolean;
  packet: EditorPacket | null;
  latest: DispatchView | null;
  history: DispatchView[];
  status: DispatchStatus;
  line: string;
};

/** Everything the job page's packet card shows. Builds the live packet, so it is for one job, not a board. */
export async function editorDispatchState(projectId: string): Promise<EditorDispatchState> {
  const [handedOver, packet, rows] = await Promise.all([
    isHandedToAgency(projectId),
    buildEditorPacket(projectId).catch(() => null),
    prisma.editorDispatch.findMany({ where: { projectId }, orderBy: { packetVersion: "desc" }, select: DISPATCH_SELECT }),
  ]);
  const history = rows.map(viewOf);
  const latest = history[0] ?? null;
  const { status, line } = dispatchLine(latest, packet?.hash ?? null);
  return { vendorKey: PACKET_VENDOR_KEY, vendorName: vendorName(), handedOver, packet, latest, history, status, line };
}

/** The Editing Room's one line per job, for many jobs at once: no packet is built (so no "out of date" here — the job page says that). */
export async function dispatchLinesFor(projectIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!projectIds.length) return out;
  const rows = await prisma.editorDispatch.findMany({
    where: { projectId: { in: projectIds } },
    orderBy: { packetVersion: "desc" },
    select: { ...DISPATCH_SELECT, projectId: true },
  });
  const newest = new Map<string, DispatchView>();
  for (const r of rows) if (!newest.has(r.projectId)) newest.set(r.projectId, viewOf(r));
  for (const id of projectIds) out.set(id, dispatchLine(newest.get(id) ?? null).line);
  return out;
}

/** "EDPK" in ASCII — the namespace half of the per-project dispatch lock (hashtext(projectId) is the other). */
const DISPATCH_LOCK_NS = 0x4544504b;

export type RecordDispatchResult =
  | { ok: true; duplicate: boolean; id: string; version: number; missing: PacketGap[] }
  | { ok: false; message: string };

/**
 * The office records that it sent the packet. Freezes the packet exactly as
 * it is now. `actor` is the person recording (a staff login); `recipient` and
 * `channel` are what they typed. Never sends anything.
 */
export async function recordEditorDispatch(
  projectId: string,
  input: { recipient: string; channel: string; note?: string | null; actor: { name: string; userId?: string | null } },
): Promise<RecordDispatchResult> {
  const recipient = (input.recipient ?? "").trim().replace(/\s+/g, " ");
  if (recipient.length < 2 || recipient.length > 200) return { ok: false, message: `Say who at ${vendorName()} it went to (an email address or a name).` };
  const channel = (input.channel ?? "").trim() as DispatchChannel;
  if (!(DISPATCH_CHANNELS as readonly string[]).includes(channel)) return { ok: false, message: "Pick how it was sent." };
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  const actor = (input.actor.name || "the office").trim().slice(0, 120);
  if (!(await isHandedToAgency(projectId))) {
    return { ok: false, message: `This job is not handed to ${vendorName()}. Reassign it to them in the Editing Room first.` };
  }
  const packet = await buildEditorPacket(projectId);
  if (!packet) return { ok: false, message: "That project no longer exists." };

  const run = () =>
    prisma.$transaction(async (tx) => {
      // ::int4 on both halves — see deliverableOutputs.lockFilmingForProject.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DISPATCH_LOCK_NS}::int4, hashtext(${projectId})::int4)`;
      const latest = await tx.editorDispatch.findFirst({ where: { projectId }, orderBy: { packetVersion: "desc" }, select: DISPATCH_SELECT });
      // The same packet to the same place is ONE send: a double click, a
      // second tab or a retry must not mint v3 for what v2 already says.
      if (
        latest &&
        !latest.supersededById &&
        latest.packetHash === packet.hash &&
        latest.recipient.toLowerCase() === recipient.toLowerCase() &&
        latest.channel === channel
      ) {
        return { duplicate: true, id: latest.id, version: latest.packetVersion };
      }
      const version = (latest?.packetVersion ?? 0) + 1;
      const row = await tx.editorDispatch.create({
        data: {
          projectId,
          vendorKey: PACKET_VENDOR_KEY,
          recipient,
          channel,
          outputIdsJson: JSON.stringify(packet.manifest.videos.map((v) => v.outputId)),
          packetVersion: version,
          packetHash: packet.hash,
          manifestJson: packet.json,
          missingJson: packet.missing.length ? JSON.stringify(packet.missing) : null,
          dispatchedBy: actor,
          // The app's clock, like every other stamp here — not the database's.
          dispatchedAt: new Date(),
        },
        select: { id: true },
      });
      await tx.editorDispatch.updateMany({ where: { projectId, supersededById: null, id: { not: row.id } }, data: { supersededById: row.id } });
      return { duplicate: false, id: row.id, version };
    });
  let res: { duplicate: boolean; id: string; version: number };
  try {
    res = await run();
  } catch (e) {
    // The unique (projectId, packetVersion) is the backstop under the lock.
    if ((e as { code?: string }).code !== "P2002") throw e;
    res = await run();
  }
  if (!res.duplicate) {
    const miss = packet.missing.length ? ` Missing when sent: ${packet.missing.map((m) => m.label).join("; ")}.` : "";
    await prisma.activity
      .create({
        data: {
          projectId,
          type: "SYSTEM",
          body: `Packet v${res.version} recorded as sent to ${vendorName()} (${DISPATCH_CHANNEL_LABEL[channel]}: ${recipient}) by ${actor}.${miss}${note ? ` Note: ${note}` : ""}`.slice(0, 2000),
        },
      })
      .catch(() => {});
  }
  return { ok: true, duplicate: res.duplicate, id: res.id, version: res.version, missing: packet.missing };
}

export type RecordAckResult = { ok: true; version: number } | { ok: false; message: string };

/** Luma said they have it. Once per version; who, how and when, and who recorded it. */
export async function recordEditorAcknowledgment(
  dispatchId: string,
  input: { projectId?: string | null; by: string; source: string; note?: string | null; actor: { name: string; userId?: string | null } },
): Promise<RecordAckResult> {
  const by = (input.by ?? "").trim().replace(/\s+/g, " ");
  if (by.length < 1 || by.length > 120) return { ok: false, message: `Say who at ${vendorName()} acknowledged it.` };
  const source = (input.source ?? "").trim() as AckSource;
  if (!(ACK_SOURCES as readonly string[]).includes(source)) return { ok: false, message: "Pick how they acknowledged it." };
  const row = await prisma.editorDispatch.findUnique({ where: { id: dispatchId }, select: { id: true, projectId: true, packetVersion: true, acknowledgedAt: true, acknowledgedBy: true } });
  if (!row || (input.projectId && row.projectId !== input.projectId)) return { ok: false, message: "That send is not on this job." };
  const actor = (input.actor.name || "the office").trim().slice(0, 120);
  const res = await prisma.editorDispatch.updateMany({
    where: { id: row.id, acknowledgedAt: null },
    data: { acknowledgedAt: new Date(), acknowledgedBy: by, ackSource: source },
  });
  if (res.count === 0) {
    const now = await prisma.editorDispatch.findUnique({ where: { id: row.id }, select: { acknowledgedAt: true, acknowledgedBy: true } });
    return { ok: false, message: `v${row.packetVersion} is already acknowledged (${now?.acknowledgedBy ?? "no name"}, ${etDateTime(now?.acknowledgedAt ?? null)}).` };
  }
  const note = (input.note ?? "").trim().slice(0, 500);
  await prisma.activity
    .create({
      data: {
        projectId: row.projectId,
        type: "SYSTEM",
        body: `${vendorName()} acknowledged packet v${row.packetVersion} (${by}, ${ACK_SOURCE_LABEL[source]}); recorded by ${actor}.${note ? ` Note: ${note}` : ""}`,
      },
    })
    .catch(() => {});
  return { ok: true, version: row.packetVersion };
}

// ---- integrity ---------------------------------------------------------------

/** The stored manifest still hashes to the fingerprint recorded with it. */
export function storedPacketIntact(row: { manifestJson: string; packetHash: string }): boolean {
  return sha256(row.manifestJson) === row.packetHash;
}

/**
 * HMAC over the packet's identity and fingerprint, with the app's own secret —
 * so a downloaded copy can be checked later against the hub ("is this the v2
 * we sent?"). Null when no secret is configured: the copy then says unsigned
 * rather than carrying a signature nobody can verify.
 */
export function packetSignature(projectId: string, version: number | "preview", hash: string): string | null {
  const secret = process.env.APP_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(`editor-packet:1:${projectId}:${version}:${hash}`).digest("hex");
}

export function verifyPacketSignature(projectId: string, version: number | "preview", hash: string, signature: string): boolean {
  const want = packetSignature(projectId, version, hash);
  if (!want || want.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(signature));
}

// ---- the printable packet ------------------------------------------------------

/** WinAnsi-safe text for the standard PDF fonts (the same folding editor-pdf does). */
function pdfSafe(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[–—]/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "");
}

export async function buildEditorPacketPdf(
  manifest: PacketManifest,
  meta: {
    version: number | null;
    hash: string;
    signature: string | null;
    missing: PacketGap[];
    dispatch?: { recipient: string; channelLabel: string; dispatchedAtISO: string; dispatchedBy: string } | null;
  },
): Promise<Uint8Array> {
  const M = 52, W = 595.28, H = 841.89;
  const INK = rgb(0.06, 0.09, 0.16), MUTED = rgb(0.39, 0.45, 0.55), BRAND = rgb(0.31, 0.275, 0.898), WARN = rgb(0.72, 0.42, 0.02);
  const doc = await PDFDocument.create();
  doc.setTitle(`${manifest.vendor.name} packet ${meta.version ? `v${meta.version}` : "(preview)"} — ${manifest.project.street}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const footer = (pg: PDFPage) =>
    pg.drawText(pdfSafe(`${manifest.project.street} - packet ${meta.version ? `v${meta.version}` : "preview"} - sha256 ${meta.hash.slice(0, 16)}${meta.signature ? ` - signed ${meta.signature.slice(0, 12)}` : " - unsigned"}`), { x: M, y: 28, size: 7, font, color: MUTED });
  const room = (need: number) => {
    if (y - need < M) {
      footer(page);
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };
  const wrap = (t: string, f: PDFFont, size: number, maxW: number): string[] => {
    const lines: string[] = [];
    for (const para of t.split("\n")) {
      let line = "";
      for (const w of para.split(/\s+/)) {
        const test = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(test, size) > maxW && line) {
          lines.push(line);
          line = w;
        } else line = test;
      }
      lines.push(line);
    }
    return lines;
  };
  const text = (t: string | null | undefined, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; x?: number } = {}) => {
    if (!t) return;
    const size = o.size ?? 10, f = o.f ?? font, x = o.x ?? M;
    for (const line of wrap(pdfSafe(t), f, size, W - M - x)) {
      room(size + 4);
      page.drawText(line, { x, y: y - size, size, font: f, color: o.color ?? INK });
      y -= size + 3;
    }
  };
  const heading = (t: string) => {
    y -= 8;
    room(24);
    page.drawText(pdfSafe(t.toUpperCase()), { x: M, y: y - 10, size: 9, font: bold, color: BRAND });
    y -= 18;
  };

  page.drawRectangle({ x: 0, y: H - 4, width: W, height: 4, color: BRAND });
  text(`RealTour Pilot - packet for ${manifest.vendor.name}`, { size: 9, f: bold, color: MUTED });
  text(manifest.project.title, { size: 18, f: bold });
  text(`${manifest.project.client}${manifest.project.packageName ? ` - ${manifest.project.packageName}` : ""}${manifest.project.shootDateISO ? ` - shot ${etDateTime(manifest.project.shootDateISO)}` : ""}`, { color: MUTED });
  text(
    meta.version
      ? `Packet v${meta.version}${meta.dispatch ? `, sent to ${meta.dispatch.recipient} (${meta.dispatch.channelLabel}) ${etDateTime(meta.dispatch.dispatchedAtISO)} by ${meta.dispatch.dispatchedBy}` : ""}`
      : "PREVIEW - not sent. This is the packet as it would go out now.",
    { size: 9, f: bold, color: meta.version ? INK : WARN },
  );

  if (meta.missing.length) {
    heading("Missing when this packet was made");
    for (const g of meta.missing) text(`-  ${g.label} (${g.owner})`, { color: WARN });
  }
  heading("Where the files are");
  text(`Raw video: ${manifest.folders.rawVideo}`);
  text(`Finished video goes in: ${manifest.folders.finalVideo}`);

  heading(`The videos (${manifest.videos.length})`);
  for (const v of manifest.videos) {
    y -= 3;
    text(`${v.index}. ${v.label}${v.format !== v.label ? ` - ${v.format}` : ""}`, { size: 11, f: bold });
    text(v.versionLabel, { size: 8, color: MUTED, x: M + 12 });
    for (const s of v.sections) text(`${s.label}: ${s.text}`, { x: M + 12 });
    if (v.brandChoice) text(`Chosen logo / branding card: ${v.brandChoice}`, { x: M + 12 });
    if (v.note) text(`From the shoot: ${v.note}`, { x: M + 12 });
    if (v.script) {
      text(`Script: ${v.script.title}${v.script.versionNo ? ` (v${v.script.versionNo})` : ""} - ${v.script.standing}`, { x: M + 12 });
      if (v.script.text) text(v.script.text, { size: 9, color: MUTED, x: M + 24 });
      const d = v.script.direction;
      if (d?.filmingNotes) text(`Filming: ${d.filmingNotes}`, { size: 9, x: M + 24 });
      if (d?.creativeDirection) text(`Direction: ${d.creativeDirection}`, { size: 9, x: M + 24 });
      if (d?.productionNotes) text(`Production: ${d.productionNotes}`, { size: 9, x: M + 24 });
    }
    if (v.rawFolder) text(`Clips: ${v.rawFolder}`, { size: 9, x: M + 12 });
    if (v.dueISO) text(`Due: ${etDateTime(v.dueISO)}`, { size: 9, color: MUTED, x: M + 12 });
  }
  if (manifest.job.instructions) {
    heading(manifest.videos.length > 1 ? "Instructions from the shoot (all videos)" : "Instructions from the shoot");
    text(manifest.job.instructions);
  }
  if (manifest.job.photographerNotes) {
    heading("Photographer's notes");
    text(manifest.job.photographerNotes);
  }
  if (manifest.job.studioScript || manifest.job.scriptStatus) {
    heading("Script");
    text(manifest.job.scriptStatus ? `Status: ${manifest.job.scriptStatus}` : null);
    text(manifest.job.studioScript);
  }
  if (manifest.revisionAsks.length) {
    heading("Open revision requests");
    for (const r of manifest.revisionAsks) text(`-  ${r}`);
  }
  if (manifest.job.specialRequests.length) {
    heading("Special requests");
    for (const r of manifest.job.specialRequests) text(`-  ${r}`);
  }
  if (manifest.job.customerNote) {
    heading("Customer notes");
    text(manifest.job.customerNote);
  }
  if (manifest.music) {
    heading("Music");
    text(manifest.music.line, { f: bold });
    if (manifest.music.file) text(`File: ${manifest.music.file}`, { size: 9, color: MUTED });
  }
  if (manifest.brand) {
    const b = manifest.brand;
    const lines = [
      b.colors.length ? `Colors: ${b.colors.map((c) => c.toUpperCase()).join(", ")}` : null,
      b.fonts ? `Fonts: ${b.fonts}` : null,
      ...b.files,
      b.music ? `Music: ${b.music}` : null,
      ...b.defaults,
      ...b.preferences.map((x) => `Preference: ${x}`),
    ].filter((x): x is string => !!x);
    if (lines.length) {
      heading("Brand kit");
      for (const l of lines) text(`-  ${l}`);
    }
  }
  heading("How to export");
  for (const l of manifest.exportSpec) text(`-  ${l}`, { size: 9 });
  footer(page);
  return doc.save();
}
