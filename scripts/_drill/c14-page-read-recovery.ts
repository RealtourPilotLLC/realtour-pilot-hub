// C14: one named critical read failure per actual signed office page, then recovery.
// Actual page/domain reads use a fresh disposable Postgres; no browser proof.
// @drill-run: engine=postgres conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";

installNextStubs();
const load = createRequire(__filename);
load.extensions[".css"] = () => { /* Next owns map styles; this fixture uses Schedule List. */ };
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.useSearchParams = () => new URLSearchParams();
}
type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
// Oct 5: Home streams its secondary sections (Suspense around async server
// components that await reads started with the page's own). Resolve those
// named components — inside the injected window — so the checks read the
// page as it finishes composing.
const STREAMED_HOME = new Set(["HomeExceptions", "HomeRadar", "OwnerBusiness"]);
async function settleHome(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settleHome));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED_HOME.has(tree.type.name)) return settleHome(await (tree.type as (props: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([key, value]) => [key, await settleHome(value)] as const))) };
}
async function settleSchedule(tree: unknown): Promise<unknown> {
  if (isValidElement<Props>(tree) && typeof tree.type === "function" && tree.type.name === "ListView") return (tree.type as (props: Props) => Promise<unknown>)(tree.props);
  return tree;
}
function record(value: unknown): Props { return value && typeof value === "object" ? value as Props : {}; }

async function main() {
  const port = Number(process.env.DRILL_PORT ?? 5601);
  if (!await portFree(port)) throw new Error(`Reserved disposable port ${port} is busy; no existing process was stopped.`);
  const db = await bootDrillDb({ port, engine: "postgres", env: { AUTH_ENFORCE: "true", APP_SECRET: "c14-isolated-page-read-recovery" } });
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { default: homePage } = await import("@/app/page");
    const home = async (props: Parameters<typeof homePage>[0]) => settleHome(await homePage(props));
    const { default: review } = await import("@/app/review/page");
    const { default: editing } = await import("@/app/editing/page");
    const { default: schedule } = await import("@/app/schedule/page");
    const { ExceptionsCard } = await import("@/components/ops/ExceptionsCard");
    const { emptyExceptionBoard } = await import("@/lib/opsExceptions");
    const client = await prisma.client.create({ data: { name: "Grove Acceptance Realty" } });
    const reviewer = await prisma.teamMember.create({ data: { name: "James", role: "MANAGER", email: "c14-read-james@example.test" } });
    const editor = await prisma.teamMember.create({ data: { name: "Kim Miguel", role: "EDITOR", email: "c14-read-kim@example.test" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle", email: "c14-read-kyle@example.test", role: "ADMIN", status: "ACTIVE" } });
    const james = await prisma.appUser.create({ data: { name: "James", email: reviewer.email!, role: "ADMIN", status: "ACTIVE", teamMemberId: reviewer.id } });
    const restricted = await prisma.appUser.create({ data: { name: "Restricted office", email: "c14-read-restricted@example.test", role: "ADMIN", status: "ACTIVE", permissions: JSON.stringify({ review: false, editing: false }) } });
    await prisma.appSetting.createMany({ data: [
      { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: reviewer.id }) },
      { key: "editor_routing", value: JSON.stringify({ standardVideo: "kim", premiumVideo: "john", personalBranding: null }) },
    ] });
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
    const job = await prisma.project.create({ data: { clientId: client.id, title: "48 Grove Lane", status: "REVIEW", shootDate: at(-4), deliveryDue: at(1), editorId: editor.id, statusEvidence: JSON.stringify({ dropbox: { rawVideo: 2 } }), deliverables: { create: { type: "VIDEO", label: "Property video" } } }, include: { deliverables: true } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId: job.id, deliverableId: job.deliverables[0].id, slot: 1, status: "PENDING", kind: "video", reviewerTeamMemberId: reviewer.id, submittedByKey: "kim", fileName: "grove-exact-round-one.mp4", assetPath: "/isolated/grove-round-one.mp4", createdAt: at(-10) } });
    await prisma.smartTask.create({ data: { projectId: job.id, clientId: client.id, title: "Edit Grove exact video", taskType: "edit_video", assignedKey: "kim", assignedManually: true, dueAt: at(1) } });
    const visit = await prisma.project.create({ data: { clientId: client.id, title: "72 Oak Visit", status: "SCHEDULED", shootDate: at(2) } });
    await prisma.appointment.create({ data: { projectId: visit.id, aryeoId: "isolated-c14-read-visit", startAt: at(2), status: "SCHEDULED" } });
    const snapshot = async () => JSON.stringify({ tasks: await prisma.smartTask.findMany({ orderBy: { id: "asc" } }), cuts: await prisma.reviewSubmission.findMany({ orderBy: { id: "asc" } }), appointments: await prisma.appointment.findMany({ orderBy: { id: "asc" } }), work: await prisma.editorWorkItem.findMany({ orderBy: { id: "asc" } }) });
    const before = await snapshot();
    const signIn = (u: typeof kyle) => setSession({ uid: u.id, email: u.email, role: u.role });
    const query = { searchParams: Promise.resolve({}) };
    // Patch only the named Prisma delegate invocation. Actual page, domain,
    // signed auth and all other reads remain real; never a product query flag.
    const inject = async <T>(delegate: { findMany: unknown }, matches: (args: Props) => boolean, run: () => Promise<T>) => {
      const original = delegate.findMany as (args: unknown) => Promise<unknown>;
      const failure = new Error("isolated named page read unavailable");
      let hits = 0;
      delegate.findMany = (args: unknown) => {
        if (matches(record(args))) { hits++; return Promise.reject(failure); }
        return original.call(delegate, args);
      };
      try {
        try { return { value: await run(), error: null, hits }; }
        catch (error) { return { value: null, error, hits }; }
      } finally { delegate.findMany = original; }
    };
    await signIn(kyle);
    const homeFailed = await inject(prisma.reviewSubmission as unknown as { findMany: unknown }, (args) => {
      const select = record(args.select);
      return record(args.where).status === "PENDING" && select.reviewerTeamMemberId === true && select.selfCheckedAt === true && record(args.orderBy).createdAt === "asc";
    }, () => home(query));
    const unavailableProps = elements(homeFailed.value, "ExceptionsCard")[0];
    const unavailableHtml = renderToStaticMarkup(createElement(ExceptionsCard, unavailableProps as Parameters<typeof ExceptionsCard>[0]));
    c.ok("Home named aging-review read failure is caught at its actual page seam", homeFailed.hits === 1 && !homeFailed.error);
    c.ok("Home failed exception pool is visibly unavailable without zero/clear reassurance", unavailableProps.unavailable === true && unavailableHtml.includes("Exceptions could not be checked") && unavailableHtml.includes('role="status"') && unavailableHtml.includes('href="/"') && !unavailableHtml.includes("0 things") && !unavailableHtml.includes("nothing waiting"));
    const scopedFailureHtml = renderToStaticMarkup(createElement(ExceptionsCard, { ...unavailableProps, includeTest: true } as Parameters<typeof ExceptionsCard>[0]));
    c.ok("unavailable retry and work-list links preserve explicit test scope", ["/?test=1", "/review?test=1", "/editing?test=1"].every((href) => scopedFailureHtml.includes(`href="${href}"`)));
    c.ok("healthy empty exception pool still stays hidden", renderToStaticMarkup(createElement(ExceptionsCard, emptyExceptionBoard())) === "");
    const recoveredHome = elements(await home(query), "ExceptionsCard")[0];
    const recoveredExceptionHtml = renderToStaticMarkup(createElement(ExceptionsCard, recoveredHome as Parameters<typeof ExceptionsCard>[0]));
    c.ok("Home read recovery restores the actual aged exact cut, not a guessed zero", recoveredExceptionHtml.includes("48 Grove Lane") && (recoveredHome.rows as { id: string }[]).some((r) => r.id === `review:${cut.id}`));
    await signIn(restricted);
    const restrictedFailure = await inject(prisma.reviewSubmission as unknown as { findMany: unknown }, (args) => {
      const select = record(args.select);
      return record(args.where).status === "PENDING" && select.reviewerTeamMemberId === true && select.selfCheckedAt === true && record(args.orderBy).createdAt === "asc";
    }, () => home(query));
    const restrictedProps = elements(restrictedFailure.value, "ExceptionsCard")[0];
    const restrictedHtml = renderToStaticMarkup(createElement(ExceptionsCard, restrictedProps as Parameters<typeof ExceptionsCard>[0]));
    c.ok("signed page overrides hide denied recovery destinations while retaining Retry Home", restrictedFailure.hits === 1 && !restrictedFailure.error && restrictedProps.canReview === false && restrictedProps.canEdit === false && restrictedHtml.includes("Retry Home") && !restrictedHtml.includes('href="/review"') && !restrictedHtml.includes('href="/editing"'));

    await signIn(james);
    const reviewFailed = await inject(prisma.reviewSubmission as unknown as { findMany: unknown }, (args) => record(record(args.include).project).select !== undefined && record(record(record(args.include).project).select).deliveredAt === true, () => review(query));
    c.ok("James Review critical submission read propagates unavailable, never a no-cuts page", reviewFailed.hits === 1 && reviewFailed.error instanceof Error && reviewFailed.error.message === "isolated named page read unavailable" && reviewFailed.value === null);
    const reviewHtml = renderToStaticMarkup(await review(query));
    c.ok("James Review retry retains the exact pending cut and assigned context", reviewHtml.includes(`cut=${cut.id}`) && reviewHtml.includes("grove-exact-round-one.mp4") && reviewHtml.includes("48 Grove Lane"));

    await signIn(kyle);
    const editingFailed = await inject(prisma.project as unknown as { findMany: unknown }, (args) => Array.isArray(record(args.where).OR) && record(args.include).editor === true && record(args.include).photographer === true, () => editing(query));
    c.ok("Kyle Editing inflight read propagates unavailable, never an empty queue", editingFailed.hits === 1 && editingFailed.error instanceof Error && editingFailed.error.message === "isolated named page read unavailable" && editingFailed.value === null);
    const recoveredQueue = elements(await editing(query), "SimpleQueue")[0];
    c.ok("Kyle Editing retry restores the exact project and saved editor", (recoveredQueue.notDone as { id: string; editorKey: string | null }[]).some((row) => row.id === job.id && row.editorKey === "kim"));

    const scheduleFailed = await inject(prisma.appointment as unknown as { findMany: unknown }, (args) => record(args.include).assignedTo === true, async () => settleSchedule(await schedule(query)));
    c.ok("Kyle Schedule appointment read propagates unavailable, never no-shoots reassurance", scheduleFailed.hits === 1 && scheduleFailed.error instanceof Error && scheduleFailed.error.message === "isolated named page read unavailable" && scheduleFailed.value === null);
    const scheduleHtml = renderToStaticMarkup(await settleSchedule(await schedule(query)) as Parameters<typeof renderToStaticMarkup>[0]);
    c.ok("Kyle Schedule retry restores the exact visit and original shoot link", scheduleHtml.includes("72 Oak Visit") && scheduleHtml.includes(`href="/shoot/${visit.id}"`) && !scheduleHtml.includes("No shoots scheduled"));
    c.ok("failure and recovery reads preserve task, exact cut, appointment and manual work state", before === await snapshot() && await prisma.editorWorkEvent.count() === 0 && await prisma.outboxMessage.count() === 0);
    c.ok("all page traffic remains fenced with no provider calls", fence.blocked.length === 0 && fence.faked.length === 0);
    console.log(await db.evidence());
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
