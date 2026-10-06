// ---------------------------------------------------------------------------
// DRILL oct5-upload-loop — the editor's hand-in, end to end (Jordan, Oct 5:
// "the editors' process smooth and seamless and every action instant").
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct5-upload-loop.ts --logs /private/tmp/oct5-upload
//
// Runs the SHIPPED server actions (startCutUpload, finishCutUpload,
// startEditingAction, uploadPanelSummary, checkContextsForProject) against an
// isolated PGlite on 127.0.0.1:DRILL_PORT (default 6520), and the SHIPPED
// client components in the same process without the react-server condition:
// CutUploader is DRIVEN (its real handlers, with a small hook dispatcher) and
// the cards it draws are rendered to HTML with react-dom/server. The byte
// store is a declared fake (upload + head); every other outbound call is
// fenced. Production is never opened.
//
//   §1 the job-level count: "1 of 3 videos approved", never "0 of 1"
//   §2 the one-screen check: every line listed and UNANSWERED (Oct 5 night
//      review: a list that started ticked recorded a pass nobody gave), ONE
//      send button that stays off until every line is answered, no
//      "(personal_branding@v1)", each line stored on its own
//   §3 brand assets: N/A only where the office recorded "intentionally none"
//   §4 the upload loop: confirmation the moment the bytes finish, the URL
//      pinned to the video just sent BEFORE the finish, then "Video 1 v1 sent
//      to James for review" + "Are you still working on this job?" + "Next:
//      Video 2 — …", the check stored per item against that exact version
//   §5 a finish that fails: an honest card with "Try again", bytes kept
//   §6 the Start bar: the video picker beside Start, on the selected video
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import type { CutRow } from "@/components/editing/CutUploader";

const PORT = Number(process.env.DRILL_PORT ?? 6520);
const req = createRequire(__filename);

installNextStubs();
const fence = fenceFetch();

// ---- next/navigation for client components ---------------------------------
const navigation = req("next/navigation") as Record<string, unknown>;
const routerCalls: string[] = [];
let searchParams = new URLSearchParams();
navigation.useRouter = () => ({
  refresh: () => { routerCalls.push("refresh"); },
  replace: (u: string) => { routerCalls.push(`replace:${u}`); },
  push: (u: string) => { routerCalls.push(`push:${u}`); },
  back() {},
  prefetch() {},
});
navigation.useSearchParams = () => searchParams;
navigation.usePathname = () => "/edit";

// ---- the byte store (declared fake) ------------------------------------------
type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const landed = new Map<string, number>();
let headFails = false;
const order: string[] = [];
// The finish, gated: CutUploader's own receipt wrapper is the seam (a static
// import), so the drill can hold the finish back and look at the screen in
// between — and see whether the URL was pinned before the finish went out.
let finishGate: Deferred | null = null;
interceptModule(
  (r) => r === "@/lib/cutUploadFinishReceipt" || /[\\/]lib[\\/]cutUploadFinishReceipt(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "cutUploadFinishReceipt") return t[k];
      const real = t[k] as (a: () => Promise<unknown>, ms?: number) => Promise<unknown>;
      return async (action: () => Promise<unknown>, ms?: number) => {
        if (finishGate) await finishGate.promise;
        order.push("finish");
        return real(action, ms);
      };
    },
  }),
);
interceptModule(
  (r) => r === "@vercel/blob/client",
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "upload") return t[k];
      return async (pathname: string, file: { size: number }, opts: { onUploadProgress?: (p: { percentage: number }) => void }) => {
        opts.onUploadProgress?.({ percentage: 60 });
        const p = pathname.replace(/\.mp4$/, "-Ab12Cd.mp4");
        const url = `https://drillstore.public.blob.vercel-storage.com/${p}`;
        landed.set(url, file.size);
        order.push("bytes");
        return { url, downloadUrl: url, pathname: p, contentType: "video/mp4", contentDisposition: "inline" };
      };
    },
  }),
);

// ---- a small hook dispatcher, so a client component's REAL handlers run ------
function mountHooks(render: () => unknown) {
  const react = req("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [];
  const effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? (next as (v: unknown) => unknown)(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const slot = index++, prior = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!prior || deps.some((v, i) => v !== prior.deps[i])) cells[slot] = { deps, value: fn() }; return (cells[slot] as { value: unknown }).value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((v, i) => v !== old[i])) { cells[slot] = deps; effects.push(() => { effect(); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (cb: () => Promise<unknown>) => { cells[slot] = true; void cb().finally(() => { cells[slot] = false; }); }]; },
    useOptimistic(passthrough: unknown) { index++; return [passthrough, () => {}]; },
  };
  return {
    render() {
      index = 0;
      const internals = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const before = internals.H;
      internals.H = dispatcher;
      try { const tree = render(); effects.splice(0).forEach((e) => e()); return tree; } finally { internals.H = before; }
    },
  };
}
type Props = Record<string, unknown>;
function named(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((t) => named(t, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string; displayName?: string };
  const hit = (typeof type === "string" ? type : type.displayName ?? type.name) === name ? [tree.props] : [];
  return [...hit, ...Object.values(tree.props).flatMap((v) => named(v, name))];
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  if (!isValidElement<Props>(tree)) return "";
  return textOf(tree.props.children);
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const plain = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const until = async (test: () => boolean | Promise<boolean>, what: string, ms = 15_000, why?: () => string) => {
  const t0 = Date.now();
  while (!(await test())) {
    if (Date.now() - t0 > ms) throw new Error(`drill: timed out waiting for ${what}${why ? ` — ${why()}` : ""}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function main() {
  const db = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "oct5-upload-loop-isolated-secret", BLOB_READ_WRITE_TOKEN: ["vercel", "blob", "rw", "drillstore", "fixture"].join("_") } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  // The store's metadata read (head) is the one network call a finish makes:
  // answered here, never sent. headFails makes it answer "not found".
  const undici = req("undici") as typeof import("undici");
  const dispatcher = undici.getGlobalDispatcher(), mock = new undici.MockAgent();
  mock.disableNetConnect();
  mock.get("https://vercel.com").intercept({ path: /\/api\/blob\/?\?/, method: "GET" }).reply((opts) => {
    const url = new URL(opts.path, "https://vercel.com").searchParams.get("url")!;
    order.push("finish:head");
    if (headFails) return { statusCode: 404, data: JSON.stringify({ error: { code: "not_found", message: "drill: not found" } }) };
    return { statusCode: 200, data: JSON.stringify({ url, downloadUrl: url, pathname: decodeURIComponent(new URL(url).pathname.slice(1)), size: landed.get(url) ?? 0, uploadedAt: new Date().toISOString(), contentType: "video/mp4", contentDisposition: "inline", cacheControl: "public" }) };
  }).persist();
  undici.setGlobalDispatcher(mock);
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/review/actions");
    const sca = await import("@/app/review/selfCheckActions");
    const sc = await import("@/lib/selfCheck");
    const scs = await import("@/lib/selfCheckStore");
    const work = await import("@/lib/editorWork");
    const workActions = await import("@/app/editing/workActions");
    const desk = await import("@/lib/editorDesk");
    const outs = await import("@/lib/deliverableOutputs");
    const { putSetting } = await import("@/lib/settings");
    const up = await import("@/components/editing/CutUploader");
    const { SelfCheckDialog } = await import("@/components/editing/SelfCheckDialog");
    const { WorkStateBar } = await import("@/components/editing/WorkStateBar");

    // ---- the world -----------------------------------------------------------
    const client = await prisma.client.create({ data: { name: "Dana Maple" }, select: { id: true } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James Livingston", email: "james@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
    await prisma.appUser.create({ data: { email: "james@drill.invalid", name: "James Livingston", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: jamesTm.id } });
    await putSetting("review_room", { discoverFromDropbox: false, keepUploadsDays: 30, creativeApproverTeamMemberId: jamesTm.id }, "drill");
    const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR" }, select: { id: true } });
    const kim = await prisma.appUser.create({ data: { email: "kim@drill.invalid", name: "Kim Miguel", role: "EDITOR", status: "ACTIVE", editorKey: "kim", teamMemberId: kimTm.id } });
    const john = await prisma.appUser.create({ data: { email: "john@drill.invalid", name: "John Mark", role: "EDITOR", status: "ACTIVE", editorKey: "john" } });
    const asUser = (u: { id: string; email: string; role: string; name: string | null }) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });
    const kimViewer = { role: "EDITOR", realRole: "EDITOR", editorKey: "kim", impersonating: false };

    const mkJob = async (title: string, style: string, label: string, quantity: number) => {
      const p = await prisma.project.create({ data: { title, clientId: client.id, status: "EDITING", editorId: kimTm.id, editorManual: true, videosOwedOverride: quantity }, select: { id: true } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label, videoStyle: style, quantity }, select: { id: true } });
      await prisma.smartTask.create({ data: { projectId: p.id, clientId: client.id, taskType: "edit_video", title: `Edit — ${title}`, status: "OPEN", assignedKey: "kim", assignedManually: true, dedupeKey: `edit-video-${p.id}` } });
      await outs.ensureOutputsForProject(p.id);
      const rows = await prisma.deliverableOutput.findMany({ where: { projectId: p.id }, orderBy: { slot: "asc" }, select: { id: true, slot: true } });
      return { id: p.id, deliverableId: d.id, out: Object.fromEntries(rows.map((r) => [r.slot, r.id])) as Record<number, string>, key: (slot: number) => `${d.id}:${slot}` };
    };
    // "Dana Maple — second session": three Personal Branding Reels. The office
    // recorded "intentionally none" for Video 1's brand assets; Video 2 is
    // named; Video 3 is already approved.
    const M = await mkJob("9 Elm Ct, Media, PA", "personal_branding", "Personal Branding Reel", 3);
    await prisma.deliverableOutput.update({ where: { id: M.out[1] }, data: { briefJson: JSON.stringify({ version: 1, sections: {}, brandAssetVersionId: null, brandChoice: "none" }) } });
    await prisma.deliverableOutput.update({ where: { id: M.out[2] }, data: { title: "A Saturday morning on Main Street" } });
    await prisma.reviewSubmission.create({ data: { projectId: M.id, deliverableId: M.deliverableId, slot: 3, round: 1, status: "APPROVED", source: "upload", fileName: "v1-slot3.mp4", submittedByKey: "kim", submittedByName: "Kim Miguel", decidedAt: new Date(), decidedBy: "James Livingston", completedAt: new Date() } });
    const row = (slot: number, latest: CutRow["latest"] = null): CutRow => ({ deliverableId: M.deliverableId, slot, label: `Personal Branding Reel — Video ${slot} of 3`, latest, openNotes: 0 });

    // =========================================================================
    c.head("§1 · the job-level count");
    // =========================================================================
    await asUser(kim);
    const summary = await sca.uploadPanelSummary(M.id);
    c.ok("the job's own read: 1 of 3 approved, James first in line", !!summary && summary.approved === 1 && summary.total === 3 && summary.firstReviewer === "James", JSON.stringify(summary && { a: summary.approved, t: summary.total, r: summary.firstReviewer }));
    c.ok("…every owed video in the page's numbering, with its topic and whether it still owes a cut",
      !!summary && JSON.stringify(summary.videos.map((v) => [v.number, v.outputId, v.topic, v.open])) === JSON.stringify([[1, M.out[1], null, true], [2, M.out[2], "A Saturday morning on Main Street", true], [3, M.out[3], null, false]]),
      JSON.stringify(summary?.videos));
    await asUser(john);
    c.ok("an editor who doesn't hold the job reads nothing", (await sca.uploadPanelSummary(M.id)) === null);
    await clearSession();
    c.ok("…nor does a signed-out caller", (await sca.uploadPanelSummary(M.id)) === null);
    await asUser(kim);
    const ctxs = await scs.checkContextsForProject(M.id);
    const panel = plain(renderToStaticMarkup(createElement(up.CutUploader, { projectId: M.id, cuts: [row(1)], canUpload: true, checks: ctxs, jobSummary: summary })));
    c.ok("the panel holding ONE video says \"1 of 3 videos approved\" — not \"0 of 1 approved\"", panel.includes("Send to Review 1 of 3 videos approved") && !/of 1 approved/.test(panel), panel.slice(0, 120));
    c.ok("…and its footer is plain words (no \"resumable parts\")", panel.includes("Pick your 1080p export, tick the short check") && !panel.includes("resumable"));

    // =========================================================================
    c.head("§2 · the one-screen check");
    // =========================================================================
    const ctx2 = ctxs[M.key(2)];
    const ids2 = { isRevision: ctx2.isRevision, openIssueIds: ctx2.issues.map((i) => i.id) };
    const asked2 = sc.itemsFor(ctx2.profile, ids2);
    const file2 = { name: "v1-main-street.mp4", size: 5150, lastModified: 2 };
    const dlg2 = renderToStaticMarkup(createElement(SelfCheckDialog, { context: ctx2, file: file2, title: "Before Video 2 goes to review", onCancel: () => {}, onSubmit: async () => ({ ok: true, message: "" }) }));
    const boxes2 = dlg2.match(/<input type="checkbox"[^>]*>/g) ?? [];
    c.ok(`every line on ONE screen: ${asked2.length} checkboxes, NONE ticked — every line starts unanswered`, boxes2.length === asked2.length && asked2.length === 6 && boxes2.every((b) => !/ checked=""/.test(b)), `${boxes2.length}/${asked2.length}`);
    const buttons2 = (dlg2.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).map((b) => ({ text: plain(b), disabled: / disabled=""/.test(b) }));
    c.ok("ONE send button, \"All checked — send it\", OFF until every line is answered — and no per-line \"Yes\" buttons",
      buttons2.filter((b) => b.text.includes("All checked — send it")).length === 1 && buttons2.find((b) => b.text.includes("All checked"))!.disabled && !buttons2.some((b) => b.text === "Yes"),
      buttons2.map((b) => b.text).join(" | "));
    c.ok("no jargon: the checklist key \"personal_branding@v1\" is never printed", !dlg2.includes("@v1") && !dlg2.includes("personal_branding"));
    // The editor's own answers: every line ticked YES (what the press records).
    const allYes = (profile: typeof ctx2.profile, ids: typeof ids2) => {
      const st = sc.oneScreenStart(profile, ids);
      for (const it of sc.itemsFor(profile, ids)) st.answer[it.key] = "YES";
      return st;
    };
    const untouched = sc.validateSelfCheck(ctx2.profile, sc.oneScreenInput(ctx2.profile, ids2, sc.oneScreenStart(ctx2.profile, ids2), file2), ids2);
    c.ok("an untouched screen sends NOTHING: no answers, all six lines missing", !untouched.ok && untouched.missing.length === 6, untouched.ok ? "" : untouched.message);
    const input2 = sc.oneScreenInput(ctx2.profile, ids2, allYes(ctx2.profile, ids2), file2);
    const v2 = sc.validateSelfCheck(ctx2.profile, input2, ids2);
    c.ok("six answered lines are a complete attestation — each line its own YES, nothing invented", v2.ok && v2.value.items.length === 6 && v2.value.items.every((i) => i.answer === "YES") && JSON.stringify(Object.keys(input2.answers)) === JSON.stringify(asked2.map((i) => i.key)));
    const naCaptions = allYes(ctx2.profile, ids2);
    naCaptions.answer.captions_text = "NA";
    naCaptions.why.captions_text = "No captions in this one.";
    const vUntick = sc.validateSelfCheck(ctx2.profile, sc.oneScreenInput(ctx2.profile, ids2, naCaptions, file2), ids2);
    c.ok("captions on a branding reel can't be waved off as \"doesn't apply\", so the send stops", !vUntick.ok && vUntick.missing.includes("captions_text"), vUntick.ok ? "" : vUntick.message);
    c.ok("the screen says how it works in one line: \"Watch the export, then tick each line that's true — or say why it doesn't apply.\"", plain(dlg2).includes("Watch the export, then tick each line that’s true — or say why it doesn’t apply."));

    // =========================================================================
    c.head("§3 · brand assets: N/A only where the office recorded intentionally none");
    // =========================================================================
    const ctx1 = ctxs[M.key(1)];
    const ids1 = { isRevision: ctx1.isRevision, openIssueIds: ctx1.issues.map((i) => i.id) };
    const brand1 = ctx1.profile.items.find((i) => i.key === "brand_assets");
    const brand2 = ctx2.profile.items.find((i) => i.key === "brand_assets");
    c.ok("Video 1 (office: intentionally none): the brand line may say \"doesn't apply\", starting there with the office's reason",
      !!brand1 && brand1.naAllowed && brand1.naDefault === true && brand1.naHint === sc.BRAND_NONE_REASON);
    c.ok("Video 2 (no such record): the brand line must be true — no N/A on a branding reel", !!brand2 && !brand2.naAllowed && !brand2.naDefault);
    c.ok("…the same list either way (same key; captions still never N/A on Video 1)", ctx1.profile.checklistKey === ctx2.profile.checklistKey && ctx1.profile.items.find((i) => i.key === "captions_text")?.naAllowed === false);
    const file1 = { name: "v1-three-rooms.mp4", size: 4242, lastModified: 1 };
    const dlg1 = renderToStaticMarkup(createElement(SelfCheckDialog, { context: ctx1, file: file1, onCancel: () => {}, onSubmit: async () => ({ ok: true, message: "" }) }));
    const boxes1 = dlg1.match(/<input type="checkbox"[^>]*>/g) ?? [];
    c.ok("the screen starts Video 1 with every line unanswered too — nothing ticked, no reason typed for the editor",
      boxes1.length === 6 && boxes1.filter((b) => / checked=""/.test(b)).length === 0 && !dlg1.includes(`value="${sc.BRAND_NONE_REASON}"`));
    const st1 = allYes(ctx1.profile, ids1);
    st1.answer.brand_assets = "NA";
    st1.why.brand_assets = sc.naStartingReason(brand1!);
    const input1 = sc.oneScreenInput(ctx1.profile, ids1, st1, file1);
    c.ok("…choosing \"Doesn't apply\" on the brand line carries the office's own recorded reason; the other five go as the YES the editor ticked",
      input1.answers.brand_assets?.answer === "NA" && input1.answers.brand_assets.reason === sc.BRAND_NONE_REASON && Object.entries(input1.answers).filter(([, a]) => a.answer === "YES").length === 5 && sc.validateSelfCheck(ctx1.profile, input1, ids1).ok);
    // The server, not the browser, decides: an N/A on Video 2's brand line is refused before anything is reserved.
    const naOn2 = allYes(ctx2.profile, ids2);
    naOn2.answer.brand_assets = "NA";
    naOn2.why.brand_assets = "No brand kit for this client yet.";
    const before2 = await prisma.reviewSubmission.count({ where: { projectId: M.id, slot: 2 } });
    const refused = await actions.startCutUpload({ projectId: M.id, deliverableId: M.deliverableId, slot: 2, fileName: file2.name, sizeBytes: file2.size, selfCheck: sc.oneScreenInput(ctx2.profile, ids2, naOn2, file2) });
    c.ok("the server refuses \"brand assets: N/A\" on Video 2 — and reserves nothing", !refused.ok && "needsSelfCheck" in refused && refused.needsSelfCheck === true && (await prisma.reviewSubmission.count({ where: { projectId: M.id, slot: 2 } })) === before2, refused.ok ? "" : refused.message);
    const std = sc.resolveSelfCheckProfile("standard_reel", null);
    c.ok("a Standard Reel keeps its own N/A on brand assets (unchanged)", std.items.find((i) => i.key === "brand_assets")?.naAllowed === true && !std.items.find((i) => i.key === "brand_assets")?.naDefault);

    // =========================================================================
    c.head("§4 · the upload loop, through the real CutUploader");
    // =========================================================================
    const start = await workActions.startEditingAction({ projectId: M.id, requestId: "oct5-start-v1", outputId: M.out[1] });
    c.ok("setup: Kim presses Start on Video 1", start.ok, start.message);
    const barOn = await work.workBarFor(M.id, kimViewer);
    // The page's own rule for who is asked (edit/[id]/page.tsx): editor mode,
    // startable, not on the job right now.
    const stillWorkingFor = async () => {
      const b = await work.workBarFor(M.id, kimViewer);
      const subs = await prisma.reviewSubmission.findMany({ where: { projectId: M.id, status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } }, orderBy: { round: "asc" }, select: { deliverableId: true, slot: true, status: true, selfCheckId: true, selfCheckedAt: true, decidedAt: true } });
      const latest = new Map<string, (typeof subs)[number]>();
      for (const s of subs) latest.set(`${s.deliverableId}:${s.slot}`, s);
      const keys = desk.openSlotKeys([1, 2, 3].map((n) => {
        const l = latest.get(M.key(n));
        return { key: M.key(n), status: l?.status ?? null, held: !!l && sc.isHeldForSelfCheck(l), approvedAtISO: l?.decidedAt?.toISOString() ?? null };
      }), new Map());
      return b && b.mode === "editor" && b.canStart && b.mine.state !== "ACTIVE" ? { openSlotKeys: keys, elsewhereStreet: b.elsewhere?.street ?? null, paused: b.mine.state === "PAUSED" } : null;
    };
    c.ok("while he is on it, the page would not ask (stillWorking null)", barOn?.mine.state === "ACTIVE" && (await stillWorkingFor()) === null);

    // A browser, as far as the panel needs one: a URL and the history it pins.
    const g = globalThis as Record<string, unknown>;
    const replaced: string[] = [];
    const win = {
      location: { href: `https://hub.drill/edit/${M.id}?queue=mine#submit-cut` },
      history: { state: null, replaceState: (_d: unknown, _t: string, url: string) => { order.push("pin"); replaced.push(url); win.location.href = new URL(url, win.location.href).href; } },
      addEventListener() {}, removeEventListener() {},
    };
    g.window = win;
    g.document = { addEventListener() {}, removeEventListener() {} };
    searchParams = new URLSearchParams("queue=mine");
    let props: Record<string, unknown> = { projectId: M.id, cuts: [row(1)], canUpload: true, checks: ctxs, stillWorking: null };
    const ui = mountHooks(() => up.CutUploader(props as Parameters<typeof up.CutUploader>[0]));
    try {
      await until(() => textOf(ui.render()).includes("1 of 3 videos approved"), "the panel's own summary read");
      c.ok("mounted: the panel reads the job's count itself — \"1 of 3 videos approved\"", true);
      const fileInput = named(ui.render(), "input").find((p) => p.type === "file")!;
      const picked = { name: file1.name, size: file1.size, type: "video/mp4", lastModified: file1.lastModified };
      (fileInput.onChange as (e: unknown) => void)({ target: { files: [picked], value: "" } });
      await until(() => named(ui.render(), "SelfCheckDialog").length === 1, "the check to open");
      const dialog = named(ui.render(), "SelfCheckDialog")[0];
      c.ok("picking the file opens the check first, titled by the page's number — \"Before Video 1 goes to review\"", dialog.title === "Before Video 1 goes to review", String(dialog.title));
      finishGate = deferred();
      const t0 = Date.now();
      const answer = await (dialog.onSubmit as (i: unknown) => Promise<{ ok: boolean }>)(input1);
      c.ok("\"All checked — send it\" answers at once (the upload runs behind it)", answer.ok && Date.now() - t0 < 50, `${Date.now() - t0}ms`);
      await until(() => named(ui.render(), "UploadSentCard").length === 1, "the hand-in card");
      const card0 = named(ui.render(), "UploadSentCard")[0];
      c.ok("THE MOMENT THE BYTES FINISH: the card is up while the finish is still waiting", card0.phase === "confirming" && order.includes("bytes"), String(card0.phase));
      const html0 = plain(renderToStaticMarkup(createElement(up.UploadSentCard, card0 as Parameters<typeof up.UploadSentCard>[0])));
      c.ok("…it says \"Video 1 v1 sent to James for review\" (· confirming…)", html0.includes("Video 1 v1 sent to James for review") && html0.includes("confirming"), html0);
      const tree0 = ui.render();
      c.ok("…the row agrees (\"v1 going to review…\") and offers no second \"Upload version 1\"", textOf(tree0).includes("v1 going to review…") && !textOf(tree0).includes("Upload version"), textOf(tree0).slice(0, 160));
      c.ok("THE VIDEO STAYS SELECTED: the URL is pinned to ?output=<Video 1> BEFORE the finish is sent (so the refresh re-renders Video 1)",
        replaced.length === 1 && replaced[0] === `/edit/${M.id}?queue=mine&output=${M.out[1]}#submit-cut` && JSON.stringify(order) === JSON.stringify(["bytes", "pin"]), `${replaced.join(", ")} · ${order.join(" → ")}`);
      finishGate.resolve();
      finishGate = null;
      await until(() => named(ui.render(), "UploadSentCard")[0]?.phase === "done", "the finish to land", 15_000, () => JSON.stringify({ card: named(ui.render(), "UploadSentCard")[0] && { phase: named(ui.render(), "UploadSentCard")[0].phase, problem: named(ui.render(), "UploadSentCard")[0].problem }, order }));
      const sub1 = await prisma.reviewSubmission.findFirstOrThrow({ where: { projectId: M.id, slot: 1 }, orderBy: { round: "desc" } });
      const check1 = await prisma.cutSelfCheck.findUniqueOrThrow({ where: { id: sub1.selfCheckId! } });
      const items1 = JSON.parse(check1.itemsJson) as { key: string; answer: string; reason: string | null }[];
      c.ok("the finish filed v1 for review, its check bound to those exact bytes", sub1.status === "PENDING" && sub1.round === 1 && !!sub1.selfCheckedAt && check1.state === "VALID" && check1.round === 1 && check1.attestedFileName === file1.name && check1.attestedSize === file1.size);
      c.ok("…the attestation stored PER ITEM: five YES, brand assets N/A with the office's reason",
        items1.length === 6 && items1.filter((i) => i.answer === "YES").length === 5 && items1.find((i) => i.key === "brand_assets")?.answer === "NA" && items1.find((i) => i.key === "brand_assets")?.reason === sc.BRAND_NONE_REASON,
        JSON.stringify(items1.map((i) => `${i.key}:${i.answer}`)));
      const barAfter = await work.workBarFor(M.id, kimViewer);
      c.ok("the hand-in ended his Start on Video 1 (editorWork, unchanged)", barAfter?.mine.state !== "ACTIVE", String(barAfter?.mine.state));
      // The page re-renders the pinned video: its row now carries v1, and the
      // page asks (stillWorking) because he is no longer on the job.
      const sw = await stillWorkingFor();
      c.ok("…so the page now asks him — Video 2 still owed", !!sw && JSON.stringify(sw.openSlotKeys) === JSON.stringify([M.key(2)]), JSON.stringify(sw));
      props = { ...props, cuts: [row(1, { id: sub1.id, round: 1, status: "PENDING", fileName: sub1.fileName, completedAt: null, note: null, sourceWidth: null, sourceHeight: null, held: false, verdict: null })], stillWorking: sw };
      await until(() => named(ui.render(), "UploadSentCard")[0]?.reviewer === "James", "the assigned reviewer read");
      const card = named(ui.render(), "UploadSentCard")[0];
      const html = renderToStaticMarkup(createElement(up.UploadSentCard, card as Parameters<typeof up.UploadSentCard>[0]));
      const words = plain(html);
      c.ok("the confirmation names the reviewer: \"Video 1 v1 sent to James for review\"", words.startsWith("Video 1 v1 sent to James for review") && !words.includes("confirming"), words);
      c.ok("…the still-working question right under it: \"Are you still working on this job? 1 more video to make here.\" + Yes / No",
        words.includes("Are you still working on this job? 1 more video to make here.") && words.includes("Yes, I’m on it") && words.includes("No, done for now") && !words.includes("Sent."), words);
      c.ok("…and one tap to the next owed video: \"Next: Video 2 — A Saturday morning on Main Street\" (keeping the queue)",
        words.includes("Next: Video 2 — A Saturday morning on Main Street") && html.includes(`href="/edit/${M.id}?output=${M.out[2]}&amp;queue=mine"`), words);
      const assigned = await sca.uploadPanelSummary(M.id, { submissionId: sub1.id });
      c.ok("the name is the reviewer the hub actually assigned (James's seat), not a guess", assigned?.sentTo === "James" && sub1.reviewerTeamMemberId === jamesTm.id, String(assigned?.sentTo));
      c.ok("the panel's count is still the job's (\"1 of 3 videos approved\") and the page was refreshed", textOf(ui.render()).includes("1 of 3 videos approved") && routerCalls.includes("refresh"));
      c.ok("the panel never starts work itself (only the prompt's Yes would)", (await prisma.editorWorkEvent.count({ where: { projectId: M.id, kind: "START" } })) === 1);

      // =======================================================================
      c.head("§5 · a finish that fails: said plainly, with Try again — bytes kept");
      // =======================================================================
      props = { ...props, cuts: [row(2)] };
      win.location.href = `https://hub.drill/edit/${M.id}?output=${M.out[2]}`;
      replaced.length = 0;
      ui.render();
      c.ok("moving to Video 2 puts Video 1's card away", named(ui.render(), "UploadSentCard").length === 0);
      const fileIn2 = named(ui.render(), "input").find((p) => p.type === "file")!;
      (fileIn2.onChange as (e: unknown) => void)({ target: { files: [{ ...file2, type: "video/mp4" }], value: "" } });
      await until(() => named(ui.render(), "SelfCheckDialog").length === 1, "Video 2's check");
      headFails = true;
      await (named(ui.render(), "SelfCheckDialog")[0].onSubmit as (i: unknown) => Promise<unknown>)(input2);
      await until(() => named(ui.render(), "UploadSentCard")[0]?.phase === "problem", "the failed finish");
      const bad = named(ui.render(), "UploadSentCard")[0];
      const badWords = plain(renderToStaticMarkup(createElement(up.UploadSentCard, bad as Parameters<typeof up.UploadSentCard>[0])));
      const sub2 = await prisma.reviewSubmission.findFirstOrThrow({ where: { projectId: M.id, slot: 2 }, orderBy: { round: "desc" } });
      c.ok("the card says what is true: \"Video 2 v1 is uploaded, but the hub hasn't confirmed it's in review yet.\" + the reason + Try again",
        badWords.includes("Video 2 v1 is uploaded, but the hub hasn’t confirmed it’s in review yet.") && badWords.includes("The file didn't land in the store") && badWords.includes("Try again"), badWords);
      c.ok("…nothing was thrown away: the reservation is still open, not cancelled", sub2.status === "UPLOADING", sub2.status);
      c.ok("…and no \"still working?\" question on a version that isn't in", !badWords.includes("Are you still working"));
      headFails = false;
      (bad.onRetry as () => void)();
      await until(() => named(ui.render(), "UploadSentCard")[0]?.phase === "done", "the retried finish");
      const sub2b = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: sub2.id } });
      c.ok("Try again finishes the SAME upload: Video 2 v1 is in review", sub2b.status === "PENDING" && !!sub2b.selfCheckedAt, sub2b.status);
      c.ok("…pinned to Video 2 (the URL already named it, so nothing to change)", replaced.length === 0, replaced.join(", "));
      const check2 = await prisma.cutSelfCheck.findUniqueOrThrow({ where: { id: sub2b.selfCheckId! } });
      c.ok("…with its own check, per item, for its own version (all six YES)", check2.state === "VALID" && check2.submissionId === sub2.id && (JSON.parse(check2.itemsJson) as { answer: string }[]).filter((i) => i.answer === "YES").length === 6);
    } finally {
      delete g.window;
      delete g.document;
    }

    // =========================================================================
    c.head("§6 · the Start bar: the video picker beside Start, on the selected video");
    // =========================================================================
    const bar = await work.workBarFor(M.id, kimViewer);
    c.ok("setup: Kim is off the job, the bar offers Start, and the picker has this job's open videos", !!bar && bar.mode === "editor" && bar.mine.state !== "ACTIVE" && bar.outputs.length >= 2, JSON.stringify(bar?.outputs));
    if (bar) {
      searchParams = new URLSearchParams();
      const withProp = renderToStaticMarkup(createElement(WorkStateBar, { bar, tz: "Asia/Manila", selectedOutputId: M.out[2] }));
      const outsideDetails = withProp.replace(/<details[\s\S]*<\/details>/, "");
      c.ok("the picker sits beside Start (not folded under details) and defaults to the selected video (Video 2)",
        new RegExp(`<option value="${M.out[2]}" selected="">`).test(outsideDetails) && outsideDetails.includes("<select"), plain(outsideDetails).slice(0, 160));
      c.ok("…the Start button is 44px tall like the rest (min-h-11)", /<button[^>]*min-h-11[^>]*>[\s\S]*?Start<\/button>/.test(withProp));
      searchParams = new URLSearchParams(`output=${M.out[1]}`);
      const fromUrl = renderToStaticMarkup(createElement(WorkStateBar, { bar, tz: "Asia/Manila" }));
      c.ok("with no prop, the URL's ?output= is the selected video (Video 1)", new RegExp(`<option value="${M.out[1]}" selected="">`).test(fromUrl));
      searchParams = new URLSearchParams("output=not-on-the-picker");
      const stray = renderToStaticMarkup(createElement(WorkStateBar, { bar, tz: "Asia/Manila" }));
      c.ok("a selected video that isn't on the picker falls back to \"Any / not sure\" — never a wrong video", /<option value="" selected="">Any \/ not sure<\/option>/.test(stray));
      // Press Start through the bar's own handler: the server records the video the picker defaulted to.
      searchParams = new URLSearchParams();
      const barUi = mountHooks(() => WorkStateBar({ bar, tz: "Asia/Manila", selectedOutputId: M.out[2] }));
      const startBtn = named(barUi.render(), "button").find((p) => textOf(p.children).includes("Start"))!;
      (startBtn.onClick as () => void)();
      await until(async () => (await prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey: "kim", projectId: M.id } } }))?.state === "ACTIVE", "the bar's Start");
      const item = await prisma.editorWorkItem.findUniqueOrThrow({ where: { editorKey_projectId: { editorKey: "kim", projectId: M.id } } });
      c.ok("pressing Start names the selected video (Video 2) — a later hand-in of Video 1 can't end it", item.outputId === M.out[2], String(item.outputId));
      c.ok("…one active job for Kim (the server's rule, untouched)", (await prisma.editorWorkItem.count({ where: { editorKey: "kim", state: "ACTIVE" } })) === 1);
    }

    c.ok("nothing left the building (no provider call was allowed through)", fence.faked.length === 0, `blocked=${fence.blocked.length}`);
    c.summary();
  } finally {
    undici.setGlobalDispatcher(dispatcher);
    await mock.close();
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
