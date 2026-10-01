// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual client handlers and server action seams with deferred, in-memory
// fakes only. No database boot, model call, provider operation or client send.
import { isValidElement, type ReactElement } from "react";
import { createRequire } from "node:module";
import { installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { contentControlOutcome, identityCorrectionPatch, reconcileIdentityFields, type ContentControlResult } from "../../src/lib/contentControlReceipt";
import type { LibraryIdentityUi } from "../../src/components/content/ContentLibraryPanel";

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function contains(tree: unknown, text: string): boolean {
  if (typeof tree === "string") return tree.includes(text);
  if (Array.isArray(tree)) return tree.some((part) => contains(part, text));
  if (!isValidElement<Props>(tree)) return false;
  const type = tree.type as unknown as { name?: string } & ((p: Props) => unknown);
  if (type.name === "MonthReceipt") return contains(type(tree.props), text);
  return Object.values(tree.props).some((part) => contains(part, text));
}
function mountHooks(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useEffect(effect: () => void, deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(effect); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
  };
  return () => {
    index = 0;
    const previous = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; }
    finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = previous; }
  };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!test()) throw new Error("month/identity fixture did not settle"); }
const button = (tree: unknown, text: string) => elements(tree, "button").find((e) => contains(e.props.children, text))!.props;
const click = (tree: unknown, text: string) => (button(tree, text).onClick as () => void)();
const change = (p: Props, value: string) => (p.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const firstSelect = (tree: unknown) => elements(tree, "select")[0].props;
const byLabel = (tree: unknown, label: string) => elements(tree, "label").find((e) => contains(e.props.children, label))!;
const field = (tree: unknown, label: string, native: "input" | "select") => elements(byLabel(tree, label), native)[0].props;

installNextStubs();
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const originals = new Map<string, NodeModule | undefined>();
  const stub = (file: string, exports: unknown) => { if (!originals.has(file)) originals.set(file, req.cache[file]); req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const contentFile = req.resolve("../../src/app/content/actions.ts"), workspaceFile = req.resolve("../../src/app/content/[id]/workspaceActions.ts");
  let result = deferred<ContentControlResult>();
  const calls: { kind: string; args: unknown[] }[] = [];
  const fake = (kind: string) => async (...args: unknown[]) => { calls.push({ kind, args }); return result.promise; };
  stub(contentFile, { moveSessionToMonth: fake("move-month"), setMonthSkipped: fake("skip") });
  stub(workspaceFile, { correctVideoIdentityAction: fake("correct"), confirmPairingAction: fake("pair"), relinkDeliveredFileAction: fake("relink"), adoptTopicVideoAction: fake("adopt") });
  const pushes: string[] = [];
  let refreshes = 0, failRefresh = false;
  const navigation = req("next/navigation") as { useRouter: () => unknown };
  const previousRouter = navigation.useRouter;
  navigation.useRouter = () => ({ push: (url: string) => pushes.push(url), refresh: () => { refreshes++; if (failRefresh) throw new Error("fixture view read failed"); } });
  try {
    const { MonthPicker, SessionMonthMover, SkipMonthButton } = await import("../../src/components/content/MonthControls");
    const { LibraryIdentityEditor } = await import("../../src/components/content/LibraryIdentityEditor");
    const picker = mountHooks(() => MonthPicker({ months: [{ key: "2026-10", label: "Oct", historical: false }, { key: "2026-09", label: "Sep", historical: true }], currentKey: "2026-09", makeHref: "/content/exact?tab=library&month=MONTH&test=1" }));
    (elements(picker(), "button").find((e) => e.props["aria-label"] === "Later month")!.props.onClick as () => void)();
    change(firstSelect(picker()), "2026-09");
    c.ok("month picker preserves exact tab/test route and encoded month navigation", pushes.join("|") === "/content/exact?tab=library&month=2026-10&test=1|/content/exact?tab=library&month=2026-09&test=1");
    let monthProps = { projectId: "exact-session", currentKey: "2026-09", monthKeys: ["2026-09"] };
    const mover = mountHooks(() => SessionMonthMover(monthProps));
    const staleSelect = firstSelect(mover()); change(staleSelect, "2026-10"); change(staleSelect, "2026-11");
    c.ok("month mover submits one exact session/month and freezes pending native input", calls.length === 1 && calls[0].args.join() === "exact-session,2026-10" && firstSelect(mover()).value === "2026-10" && firstSelect(mover()).disabled === true);
    let swallowed = 0;
    (elements(mover(), "span")[0].props.onClick as (e: { preventDefault: () => void; stopPropagation: () => void }) => void)({ preventDefault: () => swallowed++, stopPropagation: () => swallowed++ });
    c.ok("session month controls still prevent enclosing job link navigation", swallowed === 2);
    result.resolve({ ok: false, outcome: "refused", message: "Enrollment not found." });
    await until(() => contains(mover(), "Enrollment not found"));
    c.ok("known move refusal is visible and preserves requested month for deliberate retry", firstSelect(mover()).value === "2026-10" && !firstSelect(mover()).disabled && contains(mover(), "Retry selected month"));
    const staleRetry = button(mover(), "Retry selected month").onClick as () => void;
    result = deferred(); staleRetry(); result.resolve({ ok: true, outcome: "confirmed", message: "Moved to 2026-10 — the portal follows." });
    await until(() => contains(mover(), "Moved to 2026-10"));
    c.ok("confirmed move keeps its submitted month while old props await refresh", firstSelect(mover()).value === "2026-10" && refreshes === 1);
    monthProps = { ...monthProps, currentKey: "2026-10" }; mover(); mover();
    monthProps = { ...monthProps, currentKey: "2026-11" }; mover();
    c.ok("clean mover reconciles to refreshed current month without a write", firstSelect(mover()).value === "2026-11" && calls.length === 2);
    result = deferred(); change(firstSelect(mover()), "2026-12");
    result.resolve({ ok: false, outcome: "unknown", message: "The session moved to 2026-12; its library update was not confirmed. Inspect exact records before another move." });
    await until(() => contains(mover(), "library update was not confirmed"));
    const beforeUnknownRetry = calls.length; staleRetry(); change(firstSelect(mover()), "2027-01");
    c.ok("partial move preserves exact partial receipt and never rolls choice back or replays", firstSelect(mover()).value === "2027-01" && calls.length === beforeUnknownRetry && contains(mover(), "The session moved to 2026-12; its library update was not confirmed") && contains(mover(), "Further changes are held here"));
    monthProps = { ...monthProps, projectId: "other-session", currentKey: "2026-10" }; mover();
    c.ok("different session props show their own month, not an older session's uncertain draft", firstSelect(mover()).value === "2026-10");
    monthProps = { ...monthProps, projectId: "exact-session", currentKey: "2026-12" }; mover(); staleRetry();
    c.ok("returning to the same mounted session preserves unknown hold and newer selection", firstSelect(mover()).value === "2027-01" && calls.length === beforeUnknownRetry);

    let skipProps = { monthId: "exact-month", skipped: false };
    const skip = mountHooks(() => SkipMonthButton(skipProps));
    result = deferred(); const staleSkip = button(skip(), "Mark skipped").onClick as () => void; staleSkip(); staleSkip();
    c.ok("skip captures one exact target month and desired status under same-tick duplicate clicks", calls.at(-1)?.kind === "skip" && calls.at(-1)?.args[0] === "exact-month" && calls.at(-1)?.args[1] === true && button(skip(), "Mark skipped").disabled === true);
    result.resolve({ ok: false, outcome: "refused", message: "Month not found." });
    await until(() => contains(skip(), "Month not found"));
    c.ok("skip returned refusal is reported visibly and remains retryable", contains(skip(), "Month not found") && !button(skip(), "Mark skipped").disabled);
    result = deferred(); click(skip(), "Mark skipped"); skipProps = { monthId: "other-month", skipped: true }; skip();
    result.reject(new Error("skip response lost"));
    await until(() => !button(skip(), "Skipped — reopen").disabled);
    result = deferred(); click(skip(), "Skipped — reopen");
    c.ok("a late old-month receipt does not reverse a different month's action context", calls.at(-1)?.args[0] === "other-month" && calls.at(-1)?.args[1] === false);
    result.resolve({ ok: true, outcome: "confirmed", message: "Reopened." });
    await until(() => contains(skip(), "Reopened"));
    c.ok("confirmed reopen changes only confirmed UI state while old props wait", contains(skip(), "Mark skipped") && contains(skip(), "Reopened"));
    skipProps = { monthId: "exact-month", skipped: false }; skip(); staleSkip();
    c.ok("unknown skip remains held on the exact month with an honest receipt after a context round-trip", button(skip(), "Verify month state").disabled === true && contains(skip(), "request to skip month exact-month was not confirmed"));

    const options = { enrollmentId: "exact-enrollment", topics: [1, 2, 3].map((n) => ({ id: `topic-${n}`, title: `Topic ${n}`, status: "READY" })), scripts: [1, 2, 3].map((n) => ({ id: `script-${n}`, title: `Script ${n}` })) };
    const identity: LibraryIdentityUi = { section: "PREVIOUS", monthHistorical: true, confirmedAtISO: null, confirmedBy: null, flags: [], files: [{ sourceId: "exact-source", title: "Exact delivered file", externalKey: "file/exact-version.mp4", isFinal: true, matchBasis: "index", legacyKey: false, confirmedAtISO: null, confirmedBy: null }], relinkTargets: [{ id: "target-1", title: "Target 1" }, { id: "target-2", title: "Target 2" }], adoptInto: [{ id: "chain-1", title: "Chain 1" }, { id: "chain-2", title: "Chain 2" }], corrections: [] };
    let video = { id: "exact-video", title: "Original title", topicId: "topic-1", scriptId: "script-1", kind: "PROGRAM", monthKey: "2026-09", status: "FILMED" };
    const editor = mountHooks(() => LibraryIdentityEditor({ options, video, identity }));
    editor(); video = { ...video, title: "Refreshed title", topicId: "topic-2", scriptId: "script-2" }; editor();
    c.ok("clean identity editor accepts refreshed title/topic/script without creating a correction", field(editor(), "Title", "input").value === "Refreshed title" && field(editor(), "Topic", "select").value === "topic-2" && field(editor(), "Script", "select").value === "script-2" && button(editor(), "Save correction").disabled === true);
    change(field(editor(), "Counts as", "select"), "EXTRA"); change(field(editor(), "Reason", "input"), " Exact submitted reason\n ");
    video = { ...video, title: "Latest stored title", topicId: "topic-3", scriptId: "script-3" }; editor();
    result = deferred(); const beforeIdentity = calls.length; const staleIdentity = button(editor(), "Save correction").onClick as () => void; staleIdentity(); staleIdentity();
    const correction = calls.at(-1)!;
    c.ok("identity correction sends only the intended field against refreshed exact IDs/baseline", calls.length === beforeIdentity + 1 && correction.kind === "correct" && correction.args[0] === options.enrollmentId && correction.args[1] === video.id && JSON.stringify(correction.args[2]) === '{"kind":"EXTRA"}' && correction.args[3] === " Exact submitted reason\n ");
    change(field(editor(), "Title", "input"), "Newer exact title\n Keep  words "); change(field(editor(), "Reason", "input"), "Newer exact reason\n ");
    result.resolve({ ok: true, outcome: "confirmed", message: "Saved submitted kind." });
    await until(() => contains(editor(), "Saved submitted kind"));
    c.ok("late confirmed correction keeps newer exact title/reason and labels the submitted receipt", field(editor(), "Title", "input").value === "Newer exact title\n Keep  words " && field(editor(), "Reason", "input").value === "Newer exact reason\n " && contains(editor(), "Your newer input is kept; it was not part of this request"));
    video = { ...video, kind: "EXTRA", title: "Another stored title" }; editor();
    c.ok("divergent refreshed title keeps the edited words and gives a current-field warning", field(editor(), "Title", "input").value === "Newer exact title\n Keep  words " && elements(editor(), "p").some((p) => p.props.role === "alert" && contains(p, "The stored ") && contains(p, "title") && contains(p, "changed while you were editing")));
    result = deferred(); click(editor(), "Save correction"); result.resolve({ ok: false, outcome: "refused", message: "A title can't be blank." });
    await until(() => contains(editor(), "A title can't be blank"));
    c.ok("known identity refusal keeps exact editable input with alert and allows correction", field(editor(), "Title", "input").value === "Newer exact title\n Keep  words " && !button(editor(), "Save correction").disabled && elements(editor(), "p").some((p) => p.props.role === "alert" && contains(p, "A title can't be blank")));
    result = deferred(); click(editor(), "Save correction"); result.reject(new Error("lost identity write response"));
    await until(() => contains(editor(), "This result is unconfirmed"));
    const heldCalls = calls.length; staleIdentity(); click(editor(), "Right video"); click(editor(), "Confirm "); click(editor(), "Join");
    change(field(editor(), "Title", "input"), "Held newer exact title");
    c.ok("unknown identity response holds every mutation without claiming failure or losing newer words", calls.length === heldCalls && button(editor(), "Save correction").disabled === true && button(editor(), "Right video").disabled === true && button(editor(), "Confirm ").disabled === true && button(editor(), "Join").disabled === true && field(editor(), "Title", "input").value === "Held newer exact title" && !contains(editor(), "That didn't save — try again"));

    const targetEditor = mountHooks(() => LibraryIdentityEditor({ options, video: { ...video, title: "Current identity" }, identity }));
    targetEditor(); change(field(targetEditor(), "Reason", "input"), "Exact move reason");
    const moveSelect = () => elements(targetEditor(), "select").find((p) => p.props["aria-label"] === "Move this file to")!.props;
    change(moveSelect(), "target-1"); result = deferred(); click(targetEditor(), "Move");
    change(moveSelect(), "target-2"); change(field(targetEditor(), "Reason", "input"), "Newer move reason");
    c.ok("file move captures exact source/target/reason while later destination input stays editable", calls.at(-1)?.kind === "relink" && calls.at(-1)?.args.join() === "exact-enrollment,exact-source,target-1,Exact move reason" && moveSelect().value === "target-2");
    result.resolve({ ok: true, outcome: "confirmed", message: "Moved exact submitted file pairing." });
    await until(() => contains(targetEditor(), "Moved exact submitted file pairing"));
    c.ok("confirmed file receipt retains newer destination/reason and exact external file version", moveSelect().value === "target-2" && field(targetEditor(), "Reason", "input").value === "Newer move reason" && contains(targetEditor(), "file/exact-version.mp4"));
    result = deferred(); click(targetEditor(), "Right video"); result.resolve({ ok: false, outcome: "refused", message: "That delivered file isn't on this client's program." });
    await until(() => contains(targetEditor(), "That delivered file isn't"));
    c.ok("pairing refusal preserves selection/reason and names its exact source", calls.at(-1)?.args.join() === "exact-enrollment,exact-source" && moveSelect().value === "target-2" && !button(targetEditor(), "Right video").disabled);
    const joinSelect = () => elements(targetEditor(), "select").find((p) => p.props["aria-label"] === "Video with cuts to join this topic into")!.props;
    change(joinSelect(), "chain-1"); result = deferred(); click(targetEditor(), "Join"); change(joinSelect(), "chain-2");
    result.resolve({ ok: true, outcome: "confirmed", message: "Joined submitted topic row." });
    await until(() => contains(targetEditor(), "Joined submitted topic row"));
    c.ok("join receipt applies only submitted chain/topic IDs and retains newer chosen chain", calls.at(-1)?.args.join() === "exact-enrollment,chain-1,exact-video" && joinSelect().value === "chain-2");
    failRefresh = true; result = deferred(); click(targetEditor(), "Confirm "); result.resolve({ ok: true, outcome: "confirmed", message: "Month confirmed." });
    await until(() => contains(targetEditor(), "The write is confirmed; the refreshed view could not be loaded"));
    c.ok("failed read refresh does not turn confirmed month correction into a failed/unknown write", JSON.stringify(calls.at(-1)?.args[2]) === '{"confirmMonth":true}' && calls.at(-1)?.args[3] === "Newer move reason" && !button(targetEditor(), "Right video").disabled && !contains(targetEditor(), "This result is unconfirmed"));
    failRefresh = false;
    const base = { title: "Old title", topicId: "old-topic", scriptId: "old-script", kind: "PROGRAM" };
    const newer = { title: "New title", topicId: "new-topic", scriptId: "new-script", kind: "PROGRAM" };
    const merged = reconcileIdentityFields({ ...base, kind: "EXTRA" }, base, newer);
    c.ok("pure field reconciliation refreshes untouched associations and never turns them into edits", JSON.stringify(identityCorrectionPatch(merged.draft, merged.baseline)) === '{"kind":"EXTRA"}' && merged.conflicts.length === 0);
    c.ok("missing or contradictory receipt annotations fail closed instead of authorizing retry", contentControlOutcome({ ok: false, message: "Saved?" }) === "unknown" && contentControlOutcome({ ok: true, outcome: "refused", message: "Contradictory" }) === "unknown");

    // The real wrappers load only fake domains/Prisma/session dependencies.
    delete req.cache[workspaceFile]; delete req.cache[contentFile];
    let authDenied = false, domainResult: ContentControlResult = { ok: false, message: "Exact pre-write domain refusal." }, throwDomain = false, failLibrary = false;
    const domainCalls: unknown[][] = [], fakeWrites: string[] = [];
    const fakeDomain = async (...args: unknown[]) => { domainCalls.push(args); if (throwDomain) throw new Error("fixture DB/response ambiguity"); return domainResult; };
    stub(req.resolve("../../src/lib/contentVideos.ts"), { __esModule: true, correctVideoIdentity: fakeDomain, relinkDeliveredFile: fakeDomain, confirmPairing: fakeDomain, adoptTopicVideo: fakeDomain });
    stub(req.resolve("../../src/lib/auth/guards.ts"), { requireAdmin: async () => { if (authDenied) throw new Error("Forbidden"); }, requireOwner: async () => { if (authDenied) throw new Error("Owner required"); } });
    stub(req.resolve("../../src/lib/auth/session.ts"), { getSession: async () => ({ uid: "staff" }) });
    stub(req.resolve("../../src/lib/prisma.ts"), { prisma: {
      appUser: { findUnique: async () => ({ id: "staff", email: "fixture@example.invalid", role: "OWNER", status: "ACTIVE" }) },
      project: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "missing" ? null : { id: where.id, contentMonthId: "m1" }, update: async () => { fakeWrites.push("project"); } },
      contentMonth: { findUnique: async ({ where }: { where: { id: string } }) => where.id === "missing" ? null : { id: where.id, enrollmentId: "exact-enrollment", status: "OPEN", monthKey: "2026-09" }, upsert: async () => { fakeWrites.push("target-month"); return { id: "m2" }; }, update: async () => { fakeWrites.push("skip-month"); } },
      contentEnrollment: { findUnique: async () => ({ id: "exact-enrollment", clientId: "exact-client", videosPerMonth: 4, strategyCallRequired: true }) },
      portalVideo: { updateMany: async () => { fakeWrites.push("library"); if (failLibrary) throw new Error("fixture library follow failure"); } },
    } });
    const realWorkspace = await import("../../src/app/content/[id]/workspaceActions");
    const funcs = [() => realWorkspace.correctVideoIdentityAction("exact-enrollment", "exact-video", { title: "New" }, "Exact reason"), () => realWorkspace.confirmPairingAction("exact-enrollment", "exact-source"), () => realWorkspace.relinkDeliveredFileAction("exact-enrollment", "exact-source", "target-1", "Exact reason"), () => realWorkspace.adoptTopicVideoAction("exact-enrollment", "chain-1", "exact-video")];
    const refusals = await Promise.all(funcs.map((f) => f()));
    c.ok("real identity wrappers distinguish returned pre-write domain refusals with exact messages", refusals.every((r) => !r.ok && r.outcome === "refused" && r.message === "Exact pre-write domain refusal."));
    authDenied = true; const auth = await Promise.all(funcs.map((f) => f())); authDenied = false;
    c.ok("identity auth refusal annotations happen before fake domain calls", auth.every((r) => r.outcome === "refused") && domainCalls.length === 4);
    const noReason = await realWorkspace.relinkDeliveredFileAction("exact-enrollment", "exact-source", "target-1", " ");
    c.ok("existing required-reason relink refusal remains before write and exact", noReason.outcome === "refused" && noReason.message === "Say why first — moving a file changes what the client downloads." && domainCalls.length === 4);
    domainResult = { ok: true, message: "Confirmed existing domain result." }; const positive = await Promise.all(funcs.map((f) => f()));
    c.ok("real identity wrappers annotate successful/noop results as confirmed", positive.every((r) => r.ok && r.outcome === "confirmed"));
    throwDomain = true; const ambiguous = await Promise.all(funcs.map((f) => f())); throwDomain = false;
    c.ok("real identity wrappers hold thrown DB/response ambiguity with unknown outcome", ambiguous.every((r) => !r.ok && r.outcome === "unknown"));
    const cache = req("next/cache") as { revalidatePath: () => void }, originalRevalidate = cache.revalidatePath;
    cache.revalidatePath = () => { throw new Error("fixture post-write view failure"); };
    const afterWrite = await realWorkspace.correctVideoIdentityAction("exact-enrollment", "exact-video", { kind: "EXTRA" }, "Exact reason"); cache.revalidatePath = originalRevalidate;
    c.ok("identity post-write view failure is unknown, never a retryable pre-write refusal", afterWrite.outcome === "unknown");
    const realContent = await import("../../src/app/content/actions");
    const moveInvalid = await realContent.moveSessionToMonth("exact-session", "invalid");
    const moveMissing = await realContent.moveSessionToMonth("missing", "2026-10"), skipMissing = await realContent.setMonthSkipped("missing", true);
    c.ok("real month direct guards annotate refused without changing or invoking a write", moveInvalid.outcome === "refused" && moveMissing.outcome === "refused" && skipMissing.outcome === "refused" && fakeWrites.length === 0);
    const noop = await realContent.moveSessionToMonth("exact-session", "2026-09");
    c.ok("real month same-month no-op remains confirmed with no write", noop.ok && noop.outcome === "confirmed" && fakeWrites.length === 0);
    failLibrary = true; const partial = await realContent.moveSessionToMonth("exact-session", "2026-10"); failLibrary = false;
    c.ok("real month partial retains mutation order and reports unconfirmed library after session move", !partial.ok && partial.outcome === "unknown" && partial.message.includes("2026-10") && partial.message.includes("not confirmed") && fakeWrites.join() === "target-month,project,library");
    const skipConfirmed = await realContent.setMonthSkipped("m1", true);
    c.ok("real skip success is confirmed with the existing exact mutation", skipConfirmed.ok && skipConfirmed.outcome === "confirmed" && fakeWrites.at(-1) === "skip-month");
    c.ok("month/library recovery fixture makes no real DB/model/provider/client-send request", fence.blocked.length === 0);
    c.summary();
  } finally {
    for (const [file, original] of originals) { if (original) req.cache[file] = original; else delete req.cache[file]; }
    navigation.useRouter = previousRouter; fence.restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
