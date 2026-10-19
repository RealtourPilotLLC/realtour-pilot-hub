import "server-only";

import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import type { PdfScript } from "@/lib/scriptPdf";

// ---------------------------------------------------------------------------
// WHICH SCRIPTS GO IN A PDF, AND THE LINK THAT OPENS ONE (Oct 14 2026).
//
// Two PDFs:
//   · one approved script, from the agent's portal (the door checks the
//     portal's own media token, minted over the script id, and that the agent
//     approved the version on their page);
//   · a shoot's scripts, from the photographer's shoot screen, and the same
//     PDF texted to the agent. The texted link carries its own signature over
//     the shoot (no sign-in on the agent's phone), lives 30 days, and always
//     prints the CURRENT words, so an edit made after the text still shows.
// The scripts in a shoot's PDF are exactly the ones the shoot screen shows for
// this shoot: the released script, or the office's newer approval. Never a
// draft the office has not approved.
// ---------------------------------------------------------------------------

const SECRET = process.env.APP_SECRET || "dev-insecure-secret-change-me";
export const SHOOT_LINK_TTL_MS = 30 * 86_400_000;
const ID_RE = /^[a-z0-9]{10,40}$/i;

const sign = (projectId: string, exp: number) => createHmac("sha256", SECRET).update(`shoot-scripts:${projectId}:${exp}`).digest("base64url");

export function shootScriptsKey(projectId: string, now = Date.now(), ttlMs = SHOOT_LINK_TTL_MS): string {
  const exp = Math.floor((now + ttlMs) / 1000);
  return `${exp}.${sign(projectId, exp)}`;
}

export function verifyShootScriptsKey(projectId: string, key: string | null | undefined, now = Date.now()): boolean {
  if (!key || !ID_RE.test(projectId)) return false;
  const [expRaw, sig] = key.split(".");
  if (!/^\d{1,12}$/.test(expRaw ?? "") || !sig) return false;
  const exp = Number(expRaw);
  if (exp * 1000 < now) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(projectId, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The link texted to the agent: no sign-in, this shoot's scripts, 30 days. */
export function shootScriptsLink(projectId: string): string {
  return `${appBase()}/api/portal/scripts/shoot/${projectId}?k=${encodeURIComponent(shootScriptsKey(projectId))}`;
}

const fileSafe = (s: string) => s.replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "scripts";
export const pdfFileName = (s: string) => `${fileSafe(s)}.pdf`;

const etDay = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" }) : null);

/** A shoot's scripts for the PDF (the shoot screen's own choice of version), optionally just one. */
export async function shootScriptsForPdf(projectId: string, opts: { scriptId?: string | null } = {}): Promise<{ heading: string; subheading: string | null; scripts: PdfScript[]; fileName: string; enrollmentId: string | null } | null> {
  if (!ID_RE.test(projectId)) return null;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, title: true, shootDate: true, contentMonthId: true, client: { select: { name: true } } } });
  if (!p?.contentMonthId) return null;
  const month = await prisma.contentMonth.findUnique({ where: { id: p.contentMonthId }, select: { enrollmentId: true } });
  const briefs = await import("@/lib/deliverableOutputs");
  const shared = await briefs.sessionBriefFor(p.id);
  if (!shared) return null;
  const { withOfficeApprovedScripts } = await import("@/lib/shoot");
  const session = await withOfficeApprovedScripts(p.contentMonthId, shared, briefs.directionOf).catch(() => shared);
  const live = session.topics.filter((t) => !t.filmedElsewhere && t.script);
  // This shoot's share when the month is filmed over several (as the screen shows it first).
  const mine = session.shoot ? live.filter((t) => !t.plannedShoot || t.plannedShoot.n === session.shoot!.n) : live;
  const chosen = opts.scriptId ? live.filter((t) => t.script?.scriptId === opts.scriptId) : mine;
  const scripts: PdfScript[] = chosen.map((t) => ({
    title: t.script!.title || t.title,
    pillarName: t.pillarName,
    parts: t.script!.parts ? { title: t.script!.title, ...t.script!.parts } : null,
    body: t.script!.text,
    note: `Script v${t.script!.versionNo}`,
  }));
  const client = p.client?.name ?? "Your";
  const day = etDay(p.shootDate);
  return {
    heading: opts.scriptId && scripts[0] ? scripts[0].title : `${client} · Scripts`,
    subheading: [day ? `For the shoot on ${day}` : null, p.title].filter(Boolean).join(" · ") || null,
    scripts,
    fileName: pdfFileName(opts.scriptId && scripts[0] ? scripts[0].title : `${client} scripts${day ? ` ${p.shootDate!.toISOString().slice(0, 10)}` : ""}`),
    enrollmentId: month?.enrollmentId ?? null,
  };
}

/** One script the agent approved, from their portal (the version on their page). */
export async function approvedScriptForPdf(enrollmentId: string, scriptId: string): Promise<{ script: PdfScript; fileName: string } | { refused: string }> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { id: true, enrollmentId: true, historical: true, releaseState: true, sharedVersionId: true } });
  if (!s || s.enrollmentId !== enrollmentId || s.historical || s.releaseState !== "released" || !s.sharedVersionId) return { refused: "That script isn't on your page." };
  const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
  const d = (await scriptDecisionsFor(enrollmentId, [s.id])).get(s.id);
  if (d?.decision !== "APPROVED") return { refused: "Approve the script first. The PDF is there once it's approved." };
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: s.sharedVersionId }, select: { title: true, pillarId: true, categoryLabel: true, hook: true, pointsJson: true, close: true, captionCta: true, body: true, versionNo: true } });
  if (!v) return { refused: "That script isn't on your page." };
  const pillar = v.pillarId ? await prisma.contentPillar.findFirst({ where: { id: v.pillarId, enrollmentId }, select: { name: true } }) : null;
  const { sessionPartsOf } = await import("@/lib/deliverableOutputs");
  const parts = sessionPartsOf(v);
  const approvedOn = d.decidedAt ? new Date(d.decidedAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null;
  return {
    script: { title: v.title, pillarName: pillar?.name ?? (v.categoryLabel && !/^\(?\s*no\s+pillar/i.test(v.categoryLabel) ? v.categoryLabel : null), parts: parts ? { title: v.title, ...parts } : null, body: v.body, note: approvedOn ? `Approved ${approvedOn}` : "Approved" },
    fileName: pdfFileName(v.title),
  };
}

/**
 * EVERY SCRIPT ON A BULK PLAN, IN ONE PDF (Oct 19 2026, Jordan: "Rick needs
 * to be able to download all scripts in one PDF"). In plan order, each page
 * saying its filming session; only the words RELEASED to the client (the same
 * rule as the page he reads them on, portalBulk), never a draft. Null when the
 * enrollment has no bulk plan.
 */
export async function bulkScriptsForPdf(enrollmentId: string): Promise<{ heading: string; subheading: string | null; scripts: PdfScript[]; fileName: string } | null> {
  const { portalBulkView } = await import("@/lib/portalBulk");
  const view = await portalBulkView(enrollmentId);
  if (!view) return null;
  const items = view.sessions.flatMap((s) => s.items.map((x) => ({ s, x })));
  const ids = items.map(({ x }) => x.scriptId).filter((x): x is string => !!x);
  const scripts = ids.length ? await prisma.contentScript.findMany({ where: { id: { in: ids }, enrollmentId }, select: { id: true, sharedVersionId: true } }) : [];
  const versionIdOf = new Map(scripts.filter((s) => s.sharedVersionId).map((s) => [s.id, s.sharedVersionId!]));
  const versions = versionIdOf.size
    ? await prisma.contentScriptVersion.findMany({ where: { id: { in: [...versionIdOf.values()] } }, select: { id: true, title: true, pillarId: true, categoryLabel: true, hook: true, pointsJson: true, close: true, captionCta: true, body: true } })
    : [];
  const versionOf = new Map(versions.map((v) => [v.id, v]));
  const pillarIds = [...new Set(versions.map((v) => v.pillarId).filter((x): x is string => !!x))];
  const pillars = pillarIds.length ? await prisma.contentPillar.findMany({ where: { id: { in: pillarIds }, enrollmentId }, select: { id: true, name: true } }) : [];
  const pillarName = new Map(pillars.map((p) => [p.id, p.name]));
  const { sessionPartsOf } = await import("@/lib/deliverableOutputs");
  const sessionDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : null);
  const out: PdfScript[] = [];
  for (const { s, x } of items) {
    const v = x.scriptId ? versionOf.get(versionIdOf.get(x.scriptId) ?? "") : undefined;
    if (!v) continue; // not released to the client yet: not in the PDF either
    const parts = sessionPartsOf(v);
    const day = sessionDay(s.dateISO);
    const label = v.categoryLabel && !/^\(?\s*no\s+pillar/i.test(v.categoryLabel) ? v.categoryLabel : null;
    out.push({
      title: `Video ${x.no}: ${v.title}`,
      pillarName: (v.pillarId ? pillarName.get(v.pillarId) : null) ?? label,
      parts: parts ? { title: v.title, ...parts } : null,
      body: v.body,
      // The caption prints in the script itself (its own section), not here.
      note: `Session ${s.no}${day ? `, ${s.booked ? "" : "planned for "}${day}` : ""}`,
    });
  }
  const en = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  const who = en ? (await prisma.client.findUnique({ where: { id: en.clientId }, select: { name: true } }))?.name?.trim() || null : null;
  const heading = view.title || (who ? `${who}: all scripts` : "All scripts");
  return {
    heading,
    subheading: `${out.length} script${out.length === 1 ? "" : "s"} across ${view.sessions.length} filming session${view.sessions.length === 1 ? "" : "s"}, in the order we plan to film them.`,
    scripts: out,
    fileName: pdfFileName(`${who ?? "Your"} scripts`),
  };
}
