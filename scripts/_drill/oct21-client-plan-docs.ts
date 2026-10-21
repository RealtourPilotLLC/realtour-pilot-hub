// ---------------------------------------------------------------------------
// DRILL: a self-planned client's own content plan, and booking any time
// (Oct 21 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct21-client-plan-docs.ts
//
// Jordan, Oct 21: "Since Mike [Ciunci] creates his own creatives, give him the
// ability to upload a PDF or Word document so our team can access it. So he
// can schedule and upload the doc any time."
//
// The upload is the month's creative brief (Oct 8, monthBrief.ts). This drill
// holds what Oct 21 added and what Jordan's words rely on:
//
//   §1 the allowlist: PDF, Word (and a Google Docs export of either) pass;
//      a program refused by its name, and one RENAMED to .pdf / .docx refused
//      by its first bytes (briefContentRefusal); refusals carry no em dash.
//   §2 Mike's link uploads through the portal door: the recorded row, the
//      bytes in HIS Dropbox folder under "Content Plans/<YYYY-MM>/" with his
//      file name (a clash renamed, never overwritten), the private prefix as
//      the fallback, a fake PDF stores nothing, the office is belled.
//   §3 Mike's list: name, the day it was added, opened through the hub's
//      door (never a Dropbox address); he removes his own (bytes kept); the
//      portal copy says "PDF or Word document" and asks for no call.
//   §4 the team: owner/admin, the photographer and the editor on Mike's job
//      open it through the door with their login (no token, no Dropbox
//      address); others and a signed-out visit are refused; the shoot screen
//      and the editor's brief carry it.
//   §5 booking any time: a self-planned client with calls ON, no topics, no
//      answers and no call books filming (the gate is open from the 24-hour
//      floor); a planned twin is still gated; weekends, the 24-hour line and
//      the monthly allowance still hold.
//   §6 nothing sent, nothing left the machine.
//
// ISOLATION: PGlite on 127.0.0.1 (the harness). Production is never opened;
// every non-loopback call is fenced; Dropbox is an in-memory map and the
// client folder is "reachable" or not as the drill says.
// THE CLOCK IS PINNED to Wed Oct 21 2026 10:00 ET.
// ---------------------------------------------------------------------------
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5733);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 21, 14, 0, 0); // Wed Oct 21 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const et = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
const now = () => new RealDate(RealDate.now() + offset);

// ---- Dropbox, in memory (with Dropbox's autorename) -------------------------
const box = new Map<string, Buffer>();
const uploads: string[] = [];
const renamed = (path: string) => {
  if (!box.has(path)) return path;
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > path.lastIndexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 1; ; n++) if (!box.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
};
interceptModule(
  (r) => r === "@/lib/integrations/dropbox" || /[\\/]integrations[\\/]dropbox(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "dropboxUpload") return async (path: string, bytes: Uint8Array, opts: { autorename?: boolean; overwrite?: boolean } = {}) => {
        const at = opts.overwrite || opts.autorename === false ? path : renamed(path);
        box.set(at, Buffer.from(bytes)); uploads.push(at);
        return { pathDisplay: at, size: bytes.byteLength };
      };
      if (k === "dropboxDownload") return async (path: string) => { const b = box.get(path); if (!b) throw new Error("not found"); return b; };
      return t[k];
    },
  }),
);
// The client's brand folder: reachable unless the drill says otherwise. Same
// path rule as the real one (a stored path wins, else the canonical one).
let folderReachable = true;
interceptModule(
  (r) => r === "@/lib/clientFolders" || /[\\/]lib[\\/]clientFolders(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "ensureClientBrandFolder") return async (clientId: string) => {
        if (!folderReachable) return { ok: false, message: "Dropbox isn't connected." };
        const { prisma } = await import("@/lib/prisma");
        const c = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true, brandAssetsPath: true } });
        if (!c) return { ok: false, message: "Client not found." };
        const path = c.brandAssetsPath || (t.brandFolderPath as (n: string) => string)(c.name);
        if (c.brandAssetsPath !== path) await prisma.client.update({ where: { id: clientId }, data: { brandAssetsPath: path } });
        return { ok: true, path, message: "Brand folder ready." };
      };
      return t[k];
    },
  }),
);

// ---- modules that cannot load under the react-server build of React --------
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  function Link(p: unknown) { return p; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
    return realLoad.call(this, request, parent, isMain);
  };
}
installNextStubs();
const fence = fenceFetch();

/* eslint-disable @typescript-eslint/no-explicit-any */
function textOf(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => textOf(x, out)); return out; }
  if (typeof n === "object" && "props" in n) for (const v of Object.values(n.props ?? {})) textOf(v, out);
  return out;
}
function hrefsOf(n: any, out: string[] = []): string[] {
  if (n == null || typeof n !== "object") return out;
  if (Array.isArray(n)) { n.forEach((x) => hrefsOf(x, out)); return out; }
  if ("props" in n) {
    if (typeof n.props?.href === "string") out.push(n.props.href);
    for (const v of Object.values(n.props ?? {})) hrefsOf(v, out);
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const EM_DASH = "—";
const bytesOf = (head: string | number[], size: number, fill = 0x20) => {
  const b = new Uint8Array(size).fill(fill);
  b.set((typeof head === "string" ? [...Buffer.from(head)] : head).slice(0, size));
  return b;
};
const PDF = (size = 2048) => bytesOf("%PDF-1.7\n%âã\n1 0 obj\n", size);
const DOCX = (size = 1200) => bytesOf([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00], size, 0x00);
const DOC = (size = 1500) => bytesOf([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], size, 0x00);
const EXE = (size = 1024) => bytesOf([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00], size, 0x00);
const HTML = (size = 600) => bytesOf("<!doctype html><script>alert(1)</script>", size);

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct21-client-plan-docs" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { NextRequest } = await import("next/server");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const pm = await import("@/lib/programMonths");
    const portal = await import("@/lib/portal");
    const portalActions = await import("@/app/portal/actions");
    const briefActions = await import("@/app/portal/briefActions");
    const brief = await import("@/lib/monthBrief");
    const core = await import("@/lib/monthBriefCore");
    const { isDropboxUrl } = await import("@/lib/brandProfile");
    const { mediaToken } = await import("@/lib/portalMedia");
    const { yourMonthSteps } = await import("@/lib/yourMonth");
    const { homeActions } = await import("@/lib/portalHome");
    const { INSIDE_24H_MESSAGE } = await import("@/lib/sessionBooking");
    const upRoute = await import("@/app/api/portal/brief/route");
    const readRoute = await import("@/app/api/portal/brief/[monthId]/[fileId]/route");
    const { BriefReadOnly } = await import("@/components/brief/BriefReadOnly");

    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@oct21.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@oct21.test", role: "ADMIN", status: "ACTIVE" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim", email: "kim@oct21.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const remar = await prisma.appUser.create({ data: { name: "Remar", email: "remar@oct21.test", role: "EDITOR", status: "ACTIVE", editorKey: "remar" } });
    const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison", email: "harrison@oct21.test", role: "PHOTOGRAPHER", active: true } });
    const otherTm = await prisma.teamMember.create({ data: { name: "Other Shooter", email: "other@oct21.test", role: "PHOTOGRAPHER", active: true } });
    const harrison = await prisma.appUser.create({ data: { name: "Harrison", email: "harrison@oct21.test", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrisonTm.id } });
    const other = await prisma.appUser.create({ data: { name: "Other Shooter", email: "other@oct21.test", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: otherTm.id } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    const counts = async () => ({ outbox: await prisma.outboxMessage.count(), attempts: await prisma.programBookingAttempt.count() });
    const start = await counts();

    // Mike: Starter (1 session, 2 videos), plans his own content, calls ON on purpose
    // (the hardest case: the program would ask a planned client for a call).
    const M = await buildContentMonth(prisma, { name: "Mike Plans TEST", package: "Starter", monthKey: "2026-10", topics: [], project: { title: "Mike Oct TEST", shootDate: null } });
    await prisma.contentEnrollment.update({ where: { id: M.enrollmentId }, data: { clientSuppliesTopics: true, callMode: "REQUIRED", strategyCallRequired: true } });
    await pm.recalcProgramMonth(M.monthId, { now: now() });
    // Pat: the same package and calls, but we plan their content.
    const P = await buildContentMonth(prisma, { name: "Pat Planned TEST", package: "Starter", monthKey: "2026-10", topics: [], project: { title: "Pat Oct TEST", shootDate: null } });
    await prisma.contentEnrollment.update({ where: { id: P.enrollmentId }, data: { clientSuppliesTopics: false, callMode: "REQUIRED", strategyCallRequired: true } });
    await pm.recalcProgramMonth(P.monthId, { now: now() });

    // =======================================================================
    c.head("§1 · the allowlist: PDF and Word in, programs out (by name AND by bytes)");
    // =======================================================================
    const pass = (name: string, b: Uint8Array) => core.briefFileRefusal(name, b.byteLength) ?? core.briefContentRefusal(name, b);
    c.ok("a PDF, a Word .docx and an older .doc pass", pass("October plan.pdf", PDF()) === null && pass("Shot list.docx", DOCX()) === null && pass("Old plan.doc", DOC()) === null);
    c.ok("a Google Docs export (PDF or DOCX) passes, by what it is", pass("Mike plan - Google Docs.pdf", PDF()) === null && pass("Mike plan.docx", DOCX()) === null);
    c.ok("a plain text plan passes; text with binary in it does not", pass("notes.txt", bytesOf("Film the open house first.", 200)) === null && !!pass("notes.txt", EXE()));
    const exeByName = core.briefFileRefusal("tool.exe", 1024);
    const exeAsPdf = core.briefContentRefusal("plan.pdf", EXE());
    const htmlAsDocx = core.briefContentRefusal("plan.docx", HTML());
    const docxAsPdf = core.briefContentRefusal("plan.pdf", DOCX());
    c.ok(".exe is refused by its name", !!exeByName && /PDFs, Word documents/.test(exeByName), exeByName ?? "");
    c.ok("a program renamed plan.pdf is refused by its first bytes", !!exeAsPdf && /isn't a PDF/.test(exeAsPdf), exeAsPdf ?? "");
    c.ok("a web page renamed plan.docx, and a Word file named .pdf, are refused", !!htmlAsDocx && /isn't a Word document/.test(htmlAsDocx) && !!docxAsPdf, `${htmlAsDocx} | ${docxAsPdf}`);
    c.ok("SVG (it can carry script) stays refused by name", !!core.briefFileRefusal("logo.svg", 100));
    c.ok("no refusal carries an em dash", [exeByName, exeAsPdf, htmlAsDocx, docxAsPdf].every((m) => !(m ?? "").includes(EM_DASH)));

    // =======================================================================
    c.head("§2 · Mike's link uploads: the recorded row, his own Dropbox folder, the bell");
    // =======================================================================
    // A real-looking name so the office bell is not skipped as a TEST client.
    await prisma.client.update({ where: { id: M.clientId }, data: { name: "Mike Ciunci (drill)" } });
    await clearSession();
    const form = (fields: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
    const post = (f: FormData) => upRoute.POST(new NextRequest("http://127.0.0.1/api/portal/brief", { method: "POST", body: f }));
    type Up = { ok: boolean; message: string; file?: { id: string; name: string; href: string; atISO: string } };
    const planBytes = PDF(3000);
    const r1 = await post(form({ monthId: M.monthId, token: M.portalToken!, file: new File([planBytes], "October plan.pdf", { type: "application/pdf" }) }));
    const j1 = await r1.json() as Up;
    c.ok("Mike (his link) uploads his October plan as a PDF", r1.status === 200 && j1.ok && j1.file?.name === "October plan.pdf", JSON.stringify(j1));
    const row1 = await prisma.appSetting.findUnique({ where: { key: core.briefFileKey(M.monthId, j1.file!.id) } });
    const rec1 = JSON.parse(row1?.value ?? "{}") as { name?: string; size?: number; path?: string; by?: { kind?: string }; atISO?: string };
    const folder = "/AutoHDR/Client Assets/Mike Ciunci (drill)";
    c.ok("…recorded: one row, his name for it, its size, from the client, when", !!row1 && rec1.name === "October plan.pdf" && rec1.size === 3000 && rec1.by?.kind === "client" && (rec1.atISO ?? "").slice(0, 10) === "2026-10-21", row1?.value ?? "none");
    c.ok("…the bytes are in HIS Dropbox folder, Content Plans/2026-10, under his file name", rec1.path === `${folder}/Content Plans/2026-10/October plan.pdf` && Buffer.compare(box.get(rec1.path!) ?? Buffer.alloc(0), Buffer.from(planBytes)) === 0, rec1.path);
    c.ok("…and the client file now knows that folder (the brand folder the editors use)", (await prisma.client.findUniqueOrThrow({ where: { id: M.clientId } })).brandAssetsPath === folder);
    const r1b = await post(form({ monthId: M.monthId, token: M.portalToken!, file: new File([PDF(2500)], "October plan.pdf", { type: "application/pdf" }) }));
    const j1b = await r1b.json() as Up;
    const rec1b = JSON.parse((await prisma.appSetting.findUnique({ where: { key: core.briefFileKey(M.monthId, j1b.file!.id) } }))?.value ?? "{}") as { path?: string };
    c.ok("the same name again is kept beside it (Dropbox renames the clash), never written over", r1b.status === 200 && rec1b.path === `${folder}/Content Plans/2026-10/October plan (1).pdf` && box.get(rec1.path!)?.byteLength === 3000, rec1b.path);
    const r2 = await post(form({ monthId: M.monthId, token: M.portalToken!, file: new File([DOCX()], "Shot list.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }) }));
    const j2 = await r2.json() as Up;
    c.ok("a Word document goes the same way", r2.status === 200 && j2.ok && uploads.at(-1) === `${folder}/Content Plans/2026-10/Shot list.docx`, uploads.at(-1));
    const rowsBefore = await prisma.appSetting.count({ where: { key: { startsWith: core.briefMonthPrefix(M.monthId) } } });
    const boxBefore = box.size;
    const r3 = await post(form({ monthId: M.monthId, token: M.portalToken!, file: new File([EXE()], "sneaky.pdf", { type: "application/pdf" }) }));
    const j3 = await r3.json() as Up;
    const r4 = await post(form({ monthId: M.monthId, token: M.portalToken!, file: new File([EXE()], "tool.exe") }));
    c.ok("a program named .pdf, and a .exe, are refused, and nothing is stored or recorded", r3.status === 400 && /isn't a PDF/.test(j3.message) && r4.status === 400 && box.size === boxBefore && (await prisma.appSetting.count({ where: { key: { startsWith: core.briefMonthPrefix(M.monthId) } } })) === rowsBefore, `${r3.status} ${j3.message} | ${r4.status}`);
    const r5 = await post(form({ monthId: P.monthId, token: M.portalToken!, file: new File([PDF()], "not mine.pdf", { type: "application/pdf" }) }));
    c.ok("Mike's link cannot put a file on another client's month", r5.status === 403);
    const bells = await prisma.notification.findMany({ where: { kind: "content_brief" } });
    c.ok("the office is belled (owner and admin, so Kyle), once for the day, naming Mike", bells.length >= 1 && bells.some((n) => n.userKey === null && /OWNER/.test(n.audience) && /ADMIN/.test(n.audience)) && bells.every((n) => /Mike Ciunci/.test(n.title)), JSON.stringify(bells.map((n) => [n.userKey, n.audience, n.title])));
    // The client's folder can't be reached: the upload still lands, privately.
    folderReachable = false;
    const r6 = await post(form({ monthId: M.monthId, token: M.portalToken!, file: new File([PDF(900)], "Fallback plan.pdf", { type: "application/pdf" }) }));
    const j6 = await r6.json() as Up;
    folderReachable = true;
    const rec6 = JSON.parse((await prisma.appSetting.findUnique({ where: { key: core.briefFileKey(M.monthId, j6.file!.id) } }))?.value ?? "{}") as { path?: string };
    c.ok("folder unreachable: the file still lands, in the app's private prefix (the fallback)", r6.status === 200 && (rec6.path ?? "").startsWith(`/AutoHDR/Hub/content-briefs/${M.enrollmentId}/2026-10/`), rec6.path);

    // =======================================================================
    c.head("§3 · Mike's list: name, the day, opened through the hub (never Dropbox)");
    // =======================================================================
    const scope = { kind: "enrollment" as const, id: M.enrollmentId };
    const mine = await brief.briefView(await brief.monthBrief(M.monthId), scope);
    const names = mine?.files.map((f) => f.name) ?? [];
    c.ok("he sees every plan he added, by his name for it, with the day it was added", names.includes("October plan.pdf") && names.includes("Shot list.docx") && names.includes("Fallback plan.pdf") && (mine?.files ?? []).every((f) => f.atISO.slice(0, 10) === "2026-10-21"), names.join(", "));
    const hrefs = mine?.files.map((f) => f.href) ?? [];
    c.ok("each link is the hub's door with his own token, never a Dropbox address or a storage path", hrefs.length > 0 && hrefs.every((h) => h.startsWith(`/api/portal/brief/${M.monthId}/`) && /\?m=/.test(h) && !isDropboxUrl(`https://hub.realtourpilot.com${h}`) && !/dropbox|AutoHDR|Content Plans/i.test(h)), hrefs[0]);
    c.ok("nothing handed to the page carries the stored path", !JSON.stringify(mine).includes("/AutoHDR"));
    const get = (fileId: string, q = "", monthId = M.monthId) => readRoute.GET(new NextRequest(`http://127.0.0.1${core.briefFileHref(monthId, fileId)}${q}`), { params: Promise.resolve({ monthId, fileId }) });
    const tok = (fileId: string) => `?m=${encodeURIComponent(mediaToken(fileId, scope))}`;
    const g1 = await get(j1.file!.id, tok(j1.file!.id));
    const g1Bytes = Buffer.from(await g1.arrayBuffer());
    c.ok("his link opens his PDF from his folder: the bytes, shown in the browser, private", g1.status === 200 && Buffer.compare(g1Bytes, Buffer.from(planBytes)) === 0 && g1.headers.get("content-type") === "application/pdf" && /^inline/.test(g1.headers.get("content-disposition") ?? "") && g1.headers.get("cache-control") === "private, no-store", `${g1.status} ${g1.headers.get("content-disposition")}`);
    const g2 = await get(j2.file!.id, tok(j2.file!.id));
    c.ok("the Word document downloads (never shown inline)", g2.status === 200 && /^attachment/.test(g2.headers.get("content-disposition") ?? ""));
    const g6 = await get(j6.file!.id, tok(j6.file!.id));
    c.ok("the fallback file opens the same way", g6.status === 200);
    const pScope = { kind: "enrollment" as const, id: P.enrollmentId };
    const gX = await get(j1.file!.id, `?m=${encodeURIComponent(mediaToken(j1.file!.id, pScope))}`);
    c.ok("another client's token cannot open Mike's plan", gX.status === 403);
    // A recorded path outside his folder (a tampered row) is never served.
    const tamperId = "abcdef0123456789abcdef01";
    box.set("/AutoHDR/Client Assets/Someone Else/Content Plans/2026-10/x.pdf", Buffer.from(PDF()));
    await prisma.appSetting.create({ data: { key: core.briefFileKey(M.monthId, tamperId), value: JSON.stringify({ name: "x.pdf", size: 2048, mime: "application/pdf", path: "/AutoHDR/Client Assets/Someone Else/Content Plans/2026-10/x.pdf", by: { kind: "client", label: "x", id: null }, atISO: now().toISOString() }) } });
    const gT = await get(tamperId, tok(tamperId));
    await prisma.appSetting.delete({ where: { key: core.briefFileKey(M.monthId, tamperId) } });
    c.ok("a row pointing into ANOTHER client's folder is never served", gT.status === 404, String(gT.status));
    // He takes one back: the record goes, the bytes stay (nothing permanently deleted).
    const rm = await briefActions.portalRemoveBriefFile({ token: M.portalToken }, M.monthId, j1b.file!.id);
    const after = (await brief.monthBrief(M.monthId))!;
    c.ok("Mike removes his own extra copy: gone from his list, the bytes kept in Dropbox", rm.ok && !after.files.some((f) => f.id === j1b.file!.id) && box.has(rec1b.path!), rm.message);
    // The words he reads.
    const v = await portal.resolvePortalViewer({ token: M.portalToken! });
    if (!v.ok) throw new Error(v.reason);
    const plan = (await portal.portalPlanning(v.viewer.enrollment))!;
    const stepsOf = (cp: { briefFiles: number; briefNotes: boolean }) => yourMonthSteps({
      monthLabel: "October",
      planning: { callMode: plan.callMode, planningMode: plan.planningMode, callStatus: plan.callStatus, callAtISO: plan.callAtISO, noCallEligible: plan.noCallEligible, chosenAtISO: plan.chosenAtISO, deferredAtISO: plan.deferredAtISO },
      month: plan.planning!, schedule: { locked: false, reason: "", earliestISO: null, sessionsRequired: 1, sessionsMissing: 1, pendingRequest: false, capacityRemaining: 1 },
      can: { suggest: true, session: true }, readOnly: false, hrefs: { bank: "?pv=bank", month: "?pv=month", scripts: "?pv=scripts", bookingUrl: "https://calendly.invalid" },
      clientPlanned: cp, now: now(),
    });
    const empty = stepsOf({ briefFiles: 0, briefNotes: false });
    const filled = stepsOf({ briefFiles: 3, briefNotes: false });
    c.ok("Your Month: the brief step says PDF or Word document, then filming; no call, topics or answers", plan.clientPlanned && empty.map((s) => s.key).join(",") === "brief,filming" && /PDF or Word document/.test(empty[0].detail ?? "") && !empty.some((s) => ["call", "topics", "answers", "route", "scripts"].includes(s.key)), empty.map((s) => `${s.key}: ${s.title} / ${s.detail}`).join(" | "));
    c.ok("…once in, it says he can add or swap a file any time, and who sees it", /any time/.test(filled[0].detail ?? "") && /crew and editor/.test(filled[0].detail ?? ""), filled[0].detail ?? "");
    const home = homeActions({
      status: "ACTIVE", readOnly: false, perms: { session: true, suggest: true, request: true, approve: true, profile: true },
      review: { count: 0, single: null, soonestDeadlineLabel: null }, scripts: [], unread: 0,
      planning: { planningMode: plan.planningMode, callStatus: plan.callStatus, noCallEligible: plan.noCallEligible },
      month: { monthKey: "2026-10", label: "October 2026", owed: 2, selected: 0 },
      toAnswer: [], session: { offerBooking: true, required: 1, missing: 1 }, addressNeeded: 0, setup: null, ready: { count: 0, withFile: false, single: null },
      clientPlanned: { briefIn: false, monthLabel: "October 2026" },
    });
    const all = [home.primary, ...home.more].filter((a): a is NonNullable<typeof a> => !!a);
    const add = all.find((a) => a.kind === "ADD_BRIEF");
    c.ok("Home: book filming first, the plan upload offered (PDF or Word); never a call, topics or answers", home.primary?.kind === "BOOK_SESSION" && !!add && /PDF or Word/.test(add.detail ?? "") && !all.some((a) => ["BOOK_CALL", "CHOOSE_ROUTE", "PICK_TOPICS", "ANSWER_QUESTIONS", "APPROVE_SCRIPTS"].includes(a.kind)), all.map((a) => `${a.kind}: ${a.detail}`).join(" | "));
    c.ok("none of that copy carries an em dash", ![...empty, ...filled].some((s) => `${s.title}${s.detail ?? ""}`.includes(EM_DASH)) && !`${add?.title}${add?.detail}`.includes(EM_DASH));

    // =======================================================================
    c.head("§4 · the team opens it through the door, with their login");
    // =======================================================================
    await prisma.project.update({ where: { id: M.projectId! }, data: { photographerId: harrisonTm.id, editorVendorKey: "kim" } });
    await prisma.project.update({ where: { id: P.projectId! }, data: { photographerId: otherTm.id, editorVendorKey: "remar" } });
    const staffView = await brief.briefView(await brief.monthBrief(M.monthId), null);
    c.ok("staff links are the hub's door with no token (a login reads them), never Dropbox", !!staffView && staffView.files.length === 3 && staffView.files.every((f) => f.href === core.briefFileHref(M.monthId, f.id) && !/dropbox|AutoHDR/i.test(f.href)));
    const who: [string, { id: string; email: string; role: string } | null, number][] = [
      ["Jordan (owner)", owner, 200], ["Kyle (admin)", admin, 200],
      ["Harrison (shooting Mike's October)", harrison, 200], ["Kim (editing Mike's job)", kim, 200],
      ["a photographer on another client's job", other, 403], ["an editor on another client's job", remar, 403], ["signed out", null, 403],
    ];
    for (const [label, u, want] of who) {
      if (u) await signIn(u); else await clearSession();
      const g = await get(j2.file!.id);
      c.ok(`${label} → ${want === 200 ? "opens it" : "refused"}`, g.status === want, `${g.status}`);
    }
    await clearSession();
    const onJob = await brief.briefForProject(M.projectId!);
    const offJob = await brief.briefForProject(P.projectId!);
    c.ok("Mike's job carries his plan, marked client-planned (the shoot screen and the editor's brief read this)", !!onJob && onJob.clientPlanned && onJob.files.length === 3 && onJob.monthId === M.monthId);
    c.ok("Pat's job carries none of it", !!offJob && !offJob.clientPlanned && offJob.files.length === 0);
    const card = BriefReadOnly({ brief: await brief.briefView(onJob, null), clientPlanned: true, monthName: "October" });
    const words = textOf(card).join(" ");
    const cardLinks = hrefsOf(card);
    c.ok("the crew's and editor's card: the client's brief for October, client-planned, his files", /The client.s brief for\s+October/.test(words) && /Client-planned/.test(words) && words.includes("October plan.pdf") && words.includes("Shot list.docx"), words.slice(0, 160));
    c.ok("…its links are the hub's door, never a Dropbox address", cardLinks.length === 3 && cardLinks.every((h) => h.startsWith(`/api/portal/brief/${M.monthId}/`) && !/dropbox|AutoHDR/i.test(h)), cardLinks.join(", "));
    // The office: the plan sits where a planned client's topics and scripts would (Plan › Topics, Plan › Scripts).
    const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const planTab = src("src/app/content/[id]/tabs/PlanTab.tsx");
    c.ok("office Plan tab: the client's own plan on the Topics and Scripts views, client-planned only, through the hub door", (planTab.match(/<ClientOwnPlan ctx=\{ctx\} \/>/g) ?? []).length === 2 && /!ctx\.progress\?\.topics\.clientSupplies\) return null/.test(planTab) && /m\.briefView\(await m\.monthBrief\(month\.id\), null\)/.test(planTab));
    c.ok("…and the shoot screen and the editor's brief render the same card from the job's month", /briefForProject\(id\)/.test(src("src/app/shoot/[id]/page.tsx")) && /<BriefReadOnly brief=\{clientBrief\.view\}/.test(src("src/app/shoot/[id]/page.tsx")) && /<BriefReadOnly brief=\{clientBrief\.view\}/.test(src("src/app/edit/[id]/page.tsx")));

    // =======================================================================
    c.head("§5 · booking any time: no call, no answers for a self-planned client");
    // =======================================================================
    const mGate = await portal.sessionGate(M.enrollmentId, M.monthId, { now: now() });
    const pGate = await portal.sessionGate(P.enrollmentId, P.monthId, { now: now() });
    c.ok("Mike (calls on, no topics, no answers, no call): filming is open from the 24-hour floor", !mGate.locked && Math.abs(mGate.earliest.getTime() - (now().getTime() + 24 * 3_600_000)) < 60_000 && mGate.preparation?.anchor?.kind === "CLIENT_PLANNED", `${mGate.locked} ${mGate.earliest.toISOString()} ${mGate.preparation?.reason}`);
    c.ok("Pat (same package and calls, we plan): still gated on planning", pGate.locked, pGate.reason);
    const mapped = (f: { enrollmentId: string; clientId: string; monthId: string }) => prisma.programSessionPlan.create({
      data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, sessionIndex: 1, streetNumber: "117", streetName: "Main St", city: "Doylestown", stateCode: "PA", postalCode: "18901", latitude: 40.31, longitude: -75.13, geocodeSource: "drill", addressValidatedAt: new Date(), addressVersion: 1 },
    });
    const mPlan = await mapped(M);
    const pPlan = await mapped(P);
    const weekend = await portalActions.portalRequestSession({ token: M.portalToken }, { monthId: M.monthId, slotISO: et(10, 24, 10).toISOString(), planId: mPlan.id, addressVersion: 1 });
    const tooSoon = await portalActions.portalRequestSession({ token: M.portalToken }, { monthId: M.monthId, slotISO: et(10, 21, 15).toISOString(), planId: mPlan.id, addressVersion: 1 });
    c.ok("the other rules still hold for Mike: no weekends, nothing inside 24 hours", !weekend.ok && /Monday through Friday/.test(weekend.message ?? "") && !tooSoon.ok && tooSoon.message === INSIDE_24H_MESSAGE, `${weekend.message} | ${tooSoon.message}`);
    const ask = await portalActions.portalRequestSession({ token: M.portalToken }, { monthId: M.monthId, when: "Any weekday morning next week", planId: mPlan.id, addressVersion: 1 });
    const asked = await prisma.programSessionRequest.findMany({ where: { monthId: M.monthId } });
    c.ok("Mike asks for filming with no call, topics or answers: the request is taken", ask.ok && asked.length === 1 && asked[0].status === "REQUESTED", `${ask.message} ${asked.map((r) => r.status)}`);
    const again = await portalActions.portalRequestSession({ token: M.portalToken }, { monthId: M.monthId, when: "Or the week after", planId: mPlan.id, addressVersion: 1 });
    c.ok("…and the monthly allowance holds: a second ask for his one session is not a second session", (!again.ok || !!again.duplicate) && (await prisma.programSessionRequest.count({ where: { monthId: M.monthId } })) === 1, `${again.ok} ${again.message ?? ""} ${again.duplicate ?? ""}`);
    const pAsk = await portalActions.portalRequestSession({ token: P.portalToken }, { monthId: P.monthId, when: "Any weekday morning next week", planId: pPlan.id, addressVersion: 1 });
    c.ok("Pat's ask is refused by the planning gate, nothing written", !pAsk.ok && (await prisma.programSessionRequest.count({ where: { monthId: P.monthId } })) === 0, pAsk.message);
    const sched = (await portal.portalScheduleMonths(v.viewer.enrollment)).find((m) => m.monthId === M.monthId);
    c.ok("Your Month's calendar reads open and client-planned for Mike", !!sched && !sched.locked && sched.clientPlanned === true, JSON.stringify({ locked: sched?.locked, cp: sched?.clientPlanned, reason: sched?.reason }));

    // =======================================================================
    c.head("§6 · nothing sent, nothing left the machine");
    // =======================================================================
    const end = await counts();
    c.ok("no message to the client and no provider booking", end.outbox === start.outbox && end.attempts === start.attempts, JSON.stringify({ start, end }));
    c.ok("no request left the machine", fence.blocked.length === 0, JSON.stringify(fence.blocked.slice(0, 3)));
    console.log(await drill.evidence());
  } finally {
    quiet.restore();
    c.summary();
    try { await drill.stop(); } finally { fence.restore(); }
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
