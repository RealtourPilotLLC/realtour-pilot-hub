// ---------------------------------------------------------------------------
// LEGACY LIBRARY IDENTITY — the rows keyed by list position, with the evidence
// for each (unified handoff "legacy library identity exceptions", Sep 25 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_probe/legacy-library-identity.ts
//
// PortalVideo rows were once keyed `aryeo:<listing>:<n>`, n being a position in
// a filtered array; a reordered listing relabelled them. The sweep keys by
// Aryeo's video id now and rekeyIndexedLibraryRows moved every row whose URL
// matched exactly one video, so the positional rows that remain are FROZEN, not
// drifting (the completion audit counted four; this re-counts). What is still
// missing is a decision per row about which video it IS. This prints, for each:
// the client, the job, the listing, the file's title and host, which library
// video it sits under, how it got there (matchBasis) and whether a person
// confirmed it — and a disposition from that evidence alone:
//
//   settled             a person confirmed or relinked it (CP-12) — nothing to do
//   confirm pairing     the file's title names the video it already sits under
//   relink, then confirm  its title names exactly ONE other video on the same
//                       job — the identity tool's relinkDeliveredFile, then
//                       confirmPairing (both keep ContentVideoCorrection history)
//   own video           no cut chain claims it; it is its own library row —
//                       confirm it, or retire the key if the file is gone
//   ask Kyle/Jordan     anything else: two candidates, or none and a chain
//                       that might still be it
//
// Whether the file is still ON the listing is an Aryeo read, and this probe
// asks no provider anything; `scripts/rekey-portal-library.ts --dry-run` is the
// read-only pass that answers it (and re-keys the unambiguous ones for real
// without --dry-run). Nothing here writes, retires or relinks.
//
// STRUCTURALLY READ-ONLY (cp15's guard): default_transaction_read_only=on, a
// refused UPDATE proven before anything is read, every fetch refused.
// `legacyIdentityRows(prisma)` is exported so a drill can run the same reading
// over an isolated database.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

const LEGACY_KEY = /^aryeo:([^:]+):(\d+)$/;

export type Disposition = "settled" | "confirm pairing" | "relink, then confirm" | "own video" | "ask Kyle/Jordan";

export type LegacyRow = {
  portalVideoId: string;
  externalKey: string;
  listingId: string;
  position: number;
  enrollmentId: string;
  clientName: string | null;
  projectTitle: string | null;
  fileTitle: string | null;
  fileHost: string | null;
  deliveredAt: Date | null;
  underVideo: { id: string; title: string | null; monthKey: string | null; status: string; cutNames: string[] } | null;
  matchBasis: string | null;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  /** Other live videos on the same job whose cut names match the file's title. */
  titleMatches: { id: string; title: string | null }[];
  disposition: Disposition;
  why: string;
};

/** Same normalisation as contentVideos.sameVideoTitle — letters and digits,
 *  no extension, no trailing version marker; a shorter name must be 12+ chars
 *  to count as contained in a longer one. Copied, not imported: that module is
 *  server-only and this file must run as a plain script. */
function norm(s: string | null | undefined): string {
  return (s ?? "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[-_ ]*\(?\s*v\s*\d+\s*\)?(?:[-_ ]*final)?\s*$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function sameTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}
const hostOf = (u: string | null) => { try { return u ? new URL(u).host : null; } catch { return null; } };

export async function legacyIdentityRows(prisma: PrismaClient): Promise<LegacyRow[]> {
  const pvs = (await prisma.portalVideo.findMany({
    where: { source: "aryeo", externalKey: { startsWith: "aryeo:" } },
    select: { id: true, externalKey: true, enrollmentId: true, projectId: true, title: true, download: true, playback: true, deliveredAt: true },
  })).filter((r) => LEGACY_KEY.test(r.externalKey));
  if (!pvs.length) return [];
  const [sources, enrollments, projects] = await Promise.all([
    prisma.contentVideoSource.findMany({ where: { kind: "PORTAL_VIDEO", portalVideoId: { in: pvs.map((p) => p.id) } }, select: { portalVideoId: true, ref: true, videoId: true, matchBasis: true, confirmedAt: true, confirmedBy: true } }),
    prisma.contentEnrollment.findMany({ where: { id: { in: [...new Set(pvs.map((p) => p.enrollmentId))] } }, select: { id: true, clientId: true } }),
    prisma.project.findMany({ where: { id: { in: [...new Set(pvs.map((p) => p.projectId).filter((x): x is string => !!x))] } }, select: { id: true, title: true } }),
  ]);
  const clients = await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } });
  const clientOf = new Map(enrollments.map((e) => [e.id, clients.find((c) => c.id === e.clientId)?.name ?? null]));
  const projectTitle = new Map(projects.map((p) => [p.id, p.title]));
  // Every live video on these jobs, with the file names of its cut chain — the
  // candidates a file could be.
  const jobVideos = await prisma.contentVideo.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, status: { not: "ARCHIVED" } },
    select: { id: true, projectId: true, title: true, monthKey: true, status: true },
  });
  const cuts = jobVideos.length
    ? await prisma.reviewSubmission.findMany({ where: { videoId: { in: jobVideos.map((v) => v.id) } }, select: { videoId: true, fileName: true } })
    : [];
  const cutNames = (videoId: string) => [...new Set(cuts.filter((c) => c.videoId === videoId).map((c) => c.fileName).filter((x): x is string => !!x))];
  const videoById = new Map(jobVideos.map((v) => [v.id, v]));
  const extraIds = sources.map((s) => s.videoId).filter((id) => !videoById.has(id));
  if (extraIds.length) {
    for (const v of await prisma.contentVideo.findMany({ where: { id: { in: extraIds } }, select: { id: true, projectId: true, title: true, monthKey: true, status: true } })) videoById.set(v.id, v);
  }

  return pvs.map((pv): LegacyRow => {
    const m = LEGACY_KEY.exec(pv.externalKey)!;
    // The source row written under the row's CURRENT key (a stale one from
    // before a re-key is not this row's answer).
    const src = sources.find((s) => s.portalVideoId === pv.id && s.ref === pv.externalKey) ?? sources.find((s) => s.portalVideoId === pv.id) ?? null;
    const under = src ? videoById.get(src.videoId) ?? null : null;
    const matches = jobVideos.filter((v) => v.projectId === pv.projectId && v.id !== under?.id && (sameTitle(pv.title, v.title) || cutNames(v.id).some((n) => sameTitle(pv.title, n))));
    const namesUnder = under ? cutNames(under.id) : [];
    const matchesUnder = !!under && (sameTitle(pv.title, under.title) || namesUnder.some((n) => sameTitle(pv.title, n)));
    let disposition: Disposition;
    let why: string;
    if (src && (src.confirmedAt || src.matchBasis === "staff")) {
      disposition = "settled"; why = `confirmed${src.confirmedBy ? ` by ${src.confirmedBy}` : ""}${src.confirmedAt ? ` on ${src.confirmedAt.toISOString().slice(0, 10)}` : " (staff relink)"}`;
    } else if (matchesUnder && matches.length === 0) {
      disposition = "confirm pairing"; why = "its title names the video it already sits under, and no other video on the job";
    } else if (!matchesUnder && matches.length === 1) {
      disposition = "relink, then confirm"; why = `its title names "${matches[0].title ?? matches[0].id}" on the same job, not the video it sits under`;
    } else if (under && namesUnder.length === 0 && matches.length === 0) {
      disposition = "own video"; why = "no cut chain claims it — it is its own library row";
    } else {
      disposition = "ask Kyle/Jordan"; why = matches.length > 1 ? `${matches.length} videos on the job could be it` : !under ? "it sits under no library video" : "its title matches nothing on the job, and the video it sits under has cuts";
    }
    return {
      portalVideoId: pv.id, externalKey: pv.externalKey, listingId: m[1], position: Number(m[2]),
      enrollmentId: pv.enrollmentId, clientName: clientOf.get(pv.enrollmentId) ?? null, projectTitle: pv.projectId ? projectTitle.get(pv.projectId) ?? null : null,
      fileTitle: pv.title, fileHost: hostOf(pv.download ?? pv.playback), deliveredAt: pv.deliveredAt,
      underVideo: under ? { id: under.id, title: under.title, monthKey: under.monthKey, status: under.status, cutNames: namesUnder } : null,
      matchBasis: src?.matchBasis ?? null, confirmedAt: src?.confirmedAt ?? null, confirmedBy: src?.confirmedBy ?? null,
      titleMatches: matches.map((v) => ({ id: v.id, title: v.title })), disposition, why,
    };
  });
}

// ---- the command ------------------------------------------------------------

function readOnlyUrl(): string {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const m = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("DATABASE_URL not found");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}

async function main() {
  process.env.DATABASE_URL = readOnlyUrl();
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`OUTBOUND BLOCKED BY PROBE: ${typeof input === "string" ? input : "(request)"}`);
  }) as typeof fetch;
  const { prisma } = await import("../../src/lib/prisma");
  try {
    await prisma.$executeRawUnsafe(`UPDATE "Client" SET "name" = "name" WHERE false`);
    throw new Error("GUARD FAILED — the connection accepted a write");
  } catch (e) {
    if (!/25006|read-only/i.test(String(e))) throw e;
  }
  console.log("read-only connection proven (25006); outbound network refused\n");
  const rows = await legacyIdentityRows(prisma as unknown as PrismaClient);
  console.log(`POSITIONAL (LEGACY) LIBRARY ROWS: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`${r.clientName ?? "?"} · ${r.projectTitle ?? "(no job)"}`);
    console.log(`  key ${r.externalKey}  (listing ${r.listingId}, position ${r.position})  PortalVideo ${r.portalVideoId}`);
    console.log(`  file "${r.fileTitle ?? "(untitled)"}" on ${r.fileHost ?? "?"} · delivered ${r.deliveredAt?.toISOString().slice(0, 10) ?? "?"}`);
    console.log(`  under ${r.underVideo ? `"${r.underVideo.title ?? r.underVideo.id}" (${r.underVideo.monthKey ?? "no month"}, ${r.underVideo.status}; cuts: ${r.underVideo.cutNames.join(", ") || "none"})` : "no library video"} · paired by ${r.matchBasis ?? "?"}`);
    if (r.titleMatches.length) console.log(`  title also names: ${r.titleMatches.map((m) => `"${m.title ?? m.id}"`).join(", ")}`);
    console.log(`  → ${r.disposition.toUpperCase()}: ${r.why}\n`);
  }
  const tally = rows.reduce<Record<string, number>>((t, r) => ({ ...t, [r.disposition]: (t[r.disposition] ?? 0) + 1 }), {});
  console.log("by disposition:", JSON.stringify(tally));
  console.log("Is the file still on the listing? `scripts/rekey-portal-library.ts --dry-run` reads Aryeo (read-only) and says.");
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
