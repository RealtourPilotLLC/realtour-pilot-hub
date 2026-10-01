// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual control handlers and action wrappers against in-memory fakes only.
// No billing, clock change, client message, Prisma or provider is contacted.
import { createRequire } from "node:module";
import { isValidElement, type ReactElement } from "react";
import { fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { LibraryVideoUi } from "../../src/components/content/ContentLibraryPanel";

type Props = Record<string, unknown>;
type Result = { ok: boolean; message: string; outcome?: "confirmed" | "refused" | "unknown" };
function text(tree: unknown): string {
  if (typeof tree === "string") return tree;
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  return isValidElement<Props>(tree) ? text(tree.props.children) : "";
}
function buttons(tree: unknown): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap(buttons);
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as { name?: string };
  return [...(type.name === "Button" ? [tree] : []), ...buttons(tree.props.children)];
}
function named(tree: unknown, name: string): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => named(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as { name?: string };
  return [...(type.name === name ? [tree] : []), ...named(tree.props.children, name)];
}
function mount(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const i = index++; if (!(i in cells)) cells[i] = typeof initial === "function" ? initial() : initial; return [cells[i], (next: unknown) => { cells[i] = typeof next === "function" ? next(cells[i]) : next; }]; },
    useRef(initial: unknown) { const i = index++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i]; },
    useEffect(effect: () => void, deps: unknown[]) { const i = index++, old = cells[i] as unknown[] | undefined; if (!old || deps.some((x, n) => x !== old[n])) { cells[i] = deps; effects.push(effect); } },
    useTransition() { const i = index++; if (!(i in cells)) cells[i] = false; return [cells[i], (action: () => Promise<unknown>) => { cells[i] = true; void action().finally(() => { cells[i] = false; }); }]; },
  };
  return () => {
    index = 0; const old = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; }
    finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = old; }
  };
}
function deferred() { let resolve!: (r: Result) => void, reject!: (e: Error) => void; const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 5)); if (!test()) throw new Error("review control did not settle"); }
installNextStubs();
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const originals = new Map<string, NodeModule | undefined>();
  const stub = (file: string, exports: unknown) => { if (!originals.has(file)) originals.set(file, req.cache[file]); req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"), cryptoBefore = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const markers = new Map<string, string>(); let number = 0, storageFails = false;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => { if (storageFails) throw new Error("blocked storage"); return markers.get(k) ?? null; }, setItem: (k: string, v: string) => { if (storageFails) throw new Error("blocked storage"); markers.set(k, v); }, removeItem: (k: string) => markers.delete(k) } });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => `fixture-attempt-${++number}` } });
  const actionFile = req.resolve("../../src/app/content/actions.ts");
  const calls: { operation: string; args: unknown[] }[] = [];
  let result = deferred();
  const fake = (operation: string) => async (...args: unknown[]) => { calls.push({ operation, args }); return result.promise; };
  stub(actionFile, { decideRevisionFeeAction: fake("fee"), restartReviewClockAction: fake("restart"), holdReviewWindowAction: fake("hold") });
  try {
    const { ReviewMutationControls } = await import("../../src/components/content/ReviewMutationControls");
    let render = mount(() => ReviewMutationControls({ mode: "window", id: "exact-window", held: false }));
    const props = (name: string) => buttons(render()).find((b) => text(b) === name)!.props;
    const click = (name: string) => (props(name).onClick as () => void)();
    const staleRestart = props("Restart clock").onClick as () => void;
    staleRestart(); staleRestart(); click("Hold");
    c.ok("same-tick competing clock/hold handlers dispatch exactly one exact-window action", calls.length === 1 && calls[0].operation === "restart" && calls[0].args.join() === "exact-window" && props("Hold").busy === true);
    c.ok("recovery marker contains only an opaque attempt, no client words or fee", markers.size === 1 && markers.get("ops-review-attempt:window:exact-window") === "fixture-attempt-1");
    result.resolve({ ok: false, outcome: "refused", message: "This version is approved — there is no clock to restart." });
    await until(() => props("Restart clock").busy === false);
    c.ok("known domain refusal remains visible and releases only its own marker", text(render()).includes("no clock to restart") && !props("Restart clock").disabled && markers.size === 0);
    result = deferred(); click("Hold");
    c.ok("hold keeps the exact existing office reason and window ID", calls.at(-1)?.operation === "hold" && JSON.stringify(calls.at(-1)?.args) === '["exact-window",true,"Held from the Content tab"]');
    result.resolve({ ok: true, outcome: "confirmed", message: "On hold — it will not be approved automatically." });
    await until(() => props("Hold").busy === false);
    c.ok("acknowledged hold exposes its server receipt without inventing a deadline", text(render()).includes("On hold — it will not be approved automatically") && markers.size === 0);
    render = mount(() => ReviewMutationControls({ mode: "window", id: "exact-window", held: true }));
    result = deferred(); click("Release hold");
    c.ok("release preserves the exact ID and no invented hold reason", calls.at(-1)?.operation === "hold" && JSON.stringify(calls.at(-1)?.args) === '["exact-window",false,null]');
    result.reject(new Error("response lost after possible write")); await until(() => props("Release hold").busy === false);
    const beforeReplay = calls.length; staleRestart(); click("Release hold");
    c.ok("transport loss is visible uncertainty and holds all same-record actions including old handlers", text(render()).includes("may already have been recorded") && props("Restart clock").disabled === true && calls.length === beforeReplay);
    render = mount(() => ReviewMutationControls({ mode: "window", id: "exact-window", held: true })); render(); click("Release hold");
    c.ok("same-tab refresh restores exact-record hold without a mutation or expiry", text(render()).includes("previous change on this exact record is unconfirmed") && props("Release hold").disabled === true && calls.length === beforeReplay);
    render = mount(() => ReviewMutationControls({ mode: "fee", id: "exact-round" })); result = deferred(); click("Charge"); click("Waive");
    c.ok("fee choice shares pending guard and records only the exact round/decision", calls.length === beforeReplay + 1 && JSON.stringify(calls.at(-1)?.args) === '["exact-round","CHARGE"]');
    result.resolve({ ok: true, outcome: "confirmed", message: "Recorded: charge the extra round. Nothing was billed by the hub." });
    await until(() => props("Charge").busy === false);
    c.ok("confirmed fee result preserves the no-billing message and permits a later intentional choice", text(render()).includes("Nothing was billed by the hub") && !props("Waive").disabled && !markers.has("ops-review-attempt:fee:exact-round"));
    result = deferred(); click("Waive"); result.resolve({ ok: false, outcome: "unknown", message: "timeout" }); await until(() => props("Waive").busy === false);
    c.ok("returned unknown does not infer no-write from false and blocks opposing fee decisions", props("Charge").disabled === true && props("Waive").disabled === true && text(render()).includes("Waive decision: not confirmed"));
    render = mount(() => ReviewMutationControls({ mode: "window", id: "different-window", held: false })); storageFails = true; const beforeStorage = calls.length; click("Restart clock");
    c.ok("blocked storage refuses locally before a clock change, with visible recovery", calls.length === beforeStorage && text(render()).includes("No request was made") && props("Restart clock").busy === false); storageFails = false;

    const { ContentLibraryPanel } = await import("../../src/components/content/ContentLibraryPanel");
    const v: LibraryVideoUi = { id: "exact-video", title: "Exact fixture video", monthKey: "2026-10", kind: "CONTENT", countsTowardAllowance: true, status: "CLIENT_REVIEW", format: null, pillarName: null, filmedAtISO: null, deliveredAtISO: null, releasedAtISO: null, postedAtISO: null, projectId: null, scriptId: null, topicId: null, finalVersionLabel: null, source: "fixture", sources: [], cuts: [],
      reviewWindows: [{ id: "office-window", submissionId: "exact-cut", round: 2, state: "OPEN", source: "PORTAL", openedAtISO: "2026-10-01T12:00:00Z", deadlineISO: "2026-10-06T21:00:00Z", originalDeadlineISO: null, restartedBy: null, notifiedAtISO: null, viewedAtISO: null, heldReason: null, expiryOutcome: null, closedReason: null, evidence: null, decidedBy: null }],
      revisionRounds: [{ id: "office-round", ordinal: 2, included: false, includedRounds: 1, state: "OPEN", requestedBy: "Fixture client", createdAtISO: "2026-10-01T12:00:00Z", feeAckBy: null, feeAckAtISO: null, feeDecision: "PENDING", feeDecidedBy: null, feeCents: 25000, lateOverrideBy: null, answeredAtISO: null }],
    };
    const review = (video: LibraryVideoUi) => { const e = named(ContentLibraryPanel({ rows: [video], pipelineOnly: [], monthLabelText: null }), "ClientReview")[0]; return (e.type as (p: Props) => unknown)(e.props); };
    const privateView = review({ ...v, moneyEyes: false }), officeView = review({ ...v, moneyEyes: true });
    c.ok("non-money library view has no fee amount, mutation controls or billing hint", !text(privateView).includes("$250") && named(privateView, "ReviewMutationControls").length === 0 && !text(privateView).includes("Invoice it"));
    c.ok("office review controls receive exact window/round IDs with unchanged visibility", text(officeView).includes("$250 may apply") && named(officeView, "ReviewMutationControls").map((e) => `${e.props.mode}:${e.props.id}`).join() === "window:office-window,fee:office-round" && text(officeView).includes("the hub bills nothing"));
    c.ok("closed window never exposes restart/hold even to the office", named(review({ ...v, moneyEyes: true, reviewWindows: v.reviewWindows!.map((w) => ({ ...w, state: "APPROVED" })) }), "ReviewMutationControls").every((e) => e.props.mode === "fee"));

    // Real wrappers; all domain writers and database methods below are fakes.
    delete req.cache[actionFile];
    let deny = false, domainFails = false, lookupFails = false, domainOk = true, domainUnknown = false;
    const domainCalls: { operation: string; args: unknown[] }[] = [];
    const domain = (operation: string) => async (...args: unknown[]) => { domainCalls.push({ operation, args }); if (domainFails) throw new Error("fixture post-write uncertainty"); return { ok: domainOk, ...(domainUnknown ? { outcome: "unknown" } : {}), message: domainOk ? "Existing exact result" : "Existing no-write refusal" }; };
    stub(req.resolve("../../src/lib/auth/guards.ts"), { requireAdmin: async () => { if (deny) throw new Error("No access"); }, requireOwner: async () => { if (deny) throw new Error("No access"); } });
    stub(req.resolve("../../src/lib/auth/user.ts"), { __esModule: true, getCurrentUser: async () => ({ id: "fixture-office", email: "office@example.test", name: "Fixture Kyle", role: "ADMIN" }) });
    stub(req.resolve("../../src/lib/prisma.ts"), { prisma: { contentRevisionRound: { findUnique: async () => { if (lookupFails) throw new Error("read lost after domain write"); return { enrollmentId: "exact-enrollment" }; } }, contentReviewWindow: { findUnique: async () => { if (lookupFails) throw new Error("read lost after domain write"); return { enrollmentId: "exact-enrollment" }; } } } });
    stub(req.resolve("../../src/lib/contentProgram.ts"), {});
    stub(req.resolve("../../src/lib/reviewWindows.ts"), { __esModule: true, decideRevisionFee: domain("fee"), restartReviewClock: domain("restart"), holdReviewWindow: domain("hold"), releaseReviewHold: domain("release") });
    const actions = req(actionFile) as { decideRevisionFeeAction: (id: string, d: "CHARGE" | "WAIVE", note?: string) => Promise<Result>; restartReviewClockAction: (id: string) => Promise<Result>; holdReviewWindowAction: (id: string, hold: boolean, why?: string) => Promise<Result> };
    const all = () => Promise.all([actions.decideRevisionFeeAction("round", "WAIVE", "exact note"), actions.restartReviewClockAction("window"), actions.holdReviewWindowAction("window", true, "exact reason"), actions.holdReviewWindowAction("window", false)]);
    deny = true; const refused = await all();
    c.ok("existing admin boundary refuses all operations before every domain writer", refused.every((r) => !r.ok && r.outcome === "refused") && domainCalls.length === 0);
    deny = false; const confirmed = await all();
    c.ok("completed wrappers preserve exact domain results and add confirmed evidence", confirmed.every((r) => r.ok && r.outcome === "confirmed" && r.message === "Existing exact result") && domainCalls.length === 4);
    const expectedArgs: Record<string, unknown[]> = { fee: ["round", "WAIVE", "Fixture Kyle", "exact note"], restart: ["window", "Fixture Kyle"], hold: ["window", "Fixture Kyle", "exact reason"], release: ["window"] };
    c.ok("actor, IDs, fee note, hold reason and release writer stay unchanged", domainCalls.every((r) => JSON.stringify(r.args) === JSON.stringify(expectedArgs[r.operation])));
    domainOk = false; const noWrite = await all();
    c.ok("explicit domain no-write refusal remains retryable and keeps its message", noWrite.every((r) => !r.ok && r.outcome === "refused" && r.message === "Existing no-write refusal"));
    domainUnknown = true;
    const uncertainFee = await actions.decideRevisionFeeAction("round", "CHARGE");
    c.ok("explicit fee uncertainty after a won write is preserved by the wrapper", !uncertainFee.ok && uncertainFee.outcome === "unknown"); domainUnknown = false;
    domainFails = true; const unknown = await all();
    c.ok("thrown domain failure remains unknown for every wrapper", unknown.every((r) => !r.ok && r.outcome === "unknown"));
    domainFails = false; domainOk = true; lookupFails = true; const postWrite = await all();
    c.ok("post-write enrollment/read failure never becomes a retry-authorizing refusal", postWrite.every((r) => !r.ok && r.outcome === "unknown"));

    // Actual fee writer: the pending CAS can win before its next read returns
    // null. The business mutation is unchanged; only its evidence is annotated.
    const prisma = req(req.resolve("../../src/lib/prisma.ts")).prisma as { contentRevisionRound: { updateMany?: (a: unknown) => Promise<{ count: number }>; findUnique: () => Promise<unknown> } };
    let won = 1, feeWrites = 0;
    prisma.contentRevisionRound.updateMany = async () => { feeWrites++; return { count: won }; };
    prisma.contentRevisionRound.findUnique = async () => null;
    delete req.cache[req.resolve("../../src/lib/reviewWindows.ts")];
    const realDomain = req(req.resolve("../../src/lib/reviewWindows.ts")) as { decideRevisionFee: (id: string, d: "CHARGE" | "WAIVE", by: string) => Promise<Result> };
    const disappeared = await realDomain.decideRevisionFee("round-after-write", "CHARGE", "Fixture Kyle");
    c.ok("actual fee CAS won then missing read remains unknown rather than no-write refusal", feeWrites === 1 && !disappeared.ok && disappeared.outcome === "unknown");
    won = 0; const absent = await realDomain.decideRevisionFee("round-before-write", "WAIVE", "Fixture Kyle");
    c.ok("actual missing round with zero won writes stays a known refusal", feeWrites === 2 && !absent.ok && absent.outcome === "refused");
    c.ok("fixture contacted no billing, provider, Prisma or external fetch", fence.blocked.length === 0);
    c.summary();
  } finally {
    for (const [file, original] of originals) { if (original) req.cache[file] = original; else delete req.cache[file]; }
    if (storageBefore) Object.defineProperty(globalThis, "sessionStorage", storageBefore); else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (cryptoBefore) Object.defineProperty(globalThis, "crypto", cryptoBefore); else Reflect.deleteProperty(globalThis, "crypto");
    fence.restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
