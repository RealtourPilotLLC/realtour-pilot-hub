// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual component handlers + actual resource guards/actions/page, with all
// writes/readers replaced by pure in-memory fakes. No database boot or sends.
import { isValidElement, type ReactElement } from "react";
import { createRequire } from "node:module";
import { installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { ResourceRowUi } from "../../src/components/content/ResourcesAdminPanel";
import type { ResourceInput } from "../../src/lib/portalResourcesAdmin";
import type { ResourceActionResult } from "../../src/app/content/resources/actions";

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((name === "$href" ? typeof tree.props.href === "string" : (typeof type === "string" ? type : type.name) === name) ? [tree] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function contains(tree: unknown, text: string): boolean {
  if (typeof tree === "string") return tree.includes(text);
  if (Array.isArray(tree)) return tree.some((child) => contains(child, text));
  if (!isValidElement<Props>(tree)) return false;
  const type = tree.type as unknown as { name?: string } & ((props: Props) => unknown);
  if (type.name === "ResourceReceipt") return contains(type(tree.props), text);
  return Object.values(tree.props).some((child) => contains(child, text));
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
    const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; }
  };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!test()) throw new Error("resource fixture did not settle"); }
const button = (tree: unknown, label: string) => elements(tree, "button").find((e) => contains(e.props.children, label))!.props;
const click = (tree: unknown, label: string) => (button(tree, label).onClick as () => void)();
const input = (tree: unknown, placeholder: string) => elements(tree, "input").find((e) => e.props.placeholder === placeholder)!.props;
const titlePlaceholder = "Title — what the client is trying to do";
const summaryPlaceholder = "One line the client reads before opening it";
const type = (props: Props, value: string) => (props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const body = (tree: unknown) => elements(tree, "textarea")[0].props;

installNextStubs();
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const originals = new Map<string, NodeModule | undefined>();
  const stub = (file: string, exports: unknown) => { if (!originals.has(file)) originals.set(file, req.cache[file]); req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const actionFile = req.resolve("../../src/app/content/resources/actions.ts");
  let result = deferred<ResourceActionResult>();
  const calls: { kind: string; id?: string; input?: ResourceInput; published?: boolean }[] = [];
  stub(actionFile, {
    createResourceAction: async (input: ResourceInput) => { calls.push({ kind: "create", input }); return result.promise; },
    updateResourceAction: async (id: string, input: ResourceInput) => { calls.push({ kind: "update", id, input }); return result.promise; },
    publishResourceAction: async (id: string, published: boolean) => { calls.push({ kind: "publish", id, published }); return result.promise; },
    reviewResourceAction: async (id: string) => { calls.push({ kind: "review", id }); return result.promise; },
  });
  try {
    const { ResourcesAdminPanel } = await import("../../src/components/content/ResourcesAdminPanel");
    const row: ResourceRowUi = { id: "exact-guide", slug: "exact-guide", groupKey: "first", title: "Original guide", summary: "Original summary", body: "Original body", platform: "general", deviceContext: "any", ownerAppUserId: "owner", ownerName: "Guide owner", reviewedAtISO: null, linkedActions: ["prepare"], published: false, sortOrder: 9, stale: false };
    const props = { rows: [row], groups: [{ key: "first", title: "First group", blurb: "First" }, { key: "second", title: "Second group", blurb: "Second" }], platforms: ["general", "instagram"], devices: ["any", "desktop"], actions: [{ key: "prepare", label: "Prepare" }, { key: "review", label: "Review" }], staff: [{ id: "owner", name: "Guide owner" }], isOwner: true };
    const panel = mountHooks(() => ResourcesAdminPanel(props));
    let createProps: Props, createKey: string | null | undefined, createRender: (() => unknown) | undefined;
    const form = () => {
      const element = elements(panel(), "ResourceForm")[0];
      if (!createRender || createKey !== element.key) { createKey = element.key; createRender = mountHooks(() => (element.type as (p: Props) => unknown)(createProps)); }
      createProps = element.props;
      return createRender();
    };
    click(panel(), "Open draft editor");
    type(input(form(), titlePlaceholder), " Exact submitted title ");
    type(input(form(), summaryPlaceholder), " exact summary ");
    type(body(form()), "Exact markdown\n Keep  whitespace. ");
    ["second", "instagram", "desktop", "owner"].forEach((value, index) => type(elements(form(), "select")[index].props, value));
    (elements(form(), "input").find((e) => e.props.type === "checkbox" && !e.props.checked)!.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    const formBeforeFold = elements(panel(), "ResourceForm")[0];
    click(form(), "Cancel");
    c.ok("Cancel folds the same mounted new form, retaining exact title/body and all context", elements(panel(), "ResourceForm")[0].key === formBeforeFold.key && elements(panel(), "div").some((e) => e.props.hidden === true && elements(e, "ResourceForm").length === 1) && input(form(), titlePlaceholder).value === " Exact submitted title " && body(form()).value === "Exact markdown\n Keep  whitespace. " && elements(form(), "select").map((e) => e.props.value).join() === "second,instagram,desktop,owner");
    click(panel(), "Open draft editor");
    const staleSave = button(form(), "Save").onClick as () => void;
    const staleCancel = button(form(), "Cancel").onClick as () => void;
    const staleTitle = input(form(), titlePlaceholder);
    staleSave(); staleSave(); staleCancel(); type(staleTitle, "Unaccepted input while pending");
    c.ok("same-tick save/dismiss/typing guards freeze exactly one submitted draft", calls.length === 1 && calls[0].kind === "create" && input(form(), titlePlaceholder).value === " Exact submitted title " && button(form(), "Cancel").disabled === true && !elements(panel(), "div").some((e) => e.props.hidden === true && elements(e, "ResourceForm").some((x) => x.key === createKey)));
    c.ok("creation payload preserves existing normalization, exact body/options and draft sort order", calls[0].input?.title === " Exact submitted title " && calls[0].input?.summary === "exact summary" && calls[0].input?.body === "Exact markdown\n Keep  whitespace. " && calls[0].input?.groupKey === "second" && calls[0].input?.platform === "instagram" && calls[0].input?.deviceContext === "desktop" && calls[0].input?.ownerAppUserId === "owner" && calls[0].input?.linkedActions?.join() === "prepare" && calls[0].input?.sortOrder === 0);
    result.resolve({ ok: false, outcome: "refused", message: "Pick one of the four resource groups." });
    await until(() => !elements(panel(), "ResourceForm")[0].props.busy && contains(panel(), "Pick one of the four resource groups"));
    c.ok("typed pre-write refusal keeps the mounted exact draft and permits corrected retry", input(form(), titlePlaceholder).value === " Exact submitted title " && !button(form(), "Save").disabled && !contains(panel(), "It may already have been applied"));
    type(input(form(), titlePlaceholder), "Corrected draft title"); result = deferred(); click(form(), "Save");
    const oldKey = createKey;
    result.resolve({ ok: true, outcome: "confirmed", message: "Saved as a draft." });
    await until(() => contains(panel(), "Saved as a draft."));
    c.ok("only confirmed creation folds and resets the new form", input(form(), titlePlaceholder).value === "" && body(form()).value === "" && createKey !== oldKey && calls.length === 2);
    click(panel(), "Open draft editor"); type(input(form(), titlePlaceholder), "Unconfirmed exact draft"); type(body(form()), "Retained unknown body\n ");
    result = deferred(); click(form(), "Save"); result.reject(new Error("lost response after possible create"));
    await until(() => contains(panel(), "Create draft guide “Unconfirmed exact draft” was not confirmed"));
    const beforeReplay = calls.length; staleSave(); click(form(), "Save");
    c.ok("thrown creation retains exact words, labels uncertainty and blocks blind replay including stale callbacks", input(form(), titlePlaceholder).value === "Unconfirmed exact draft" && body(form()).value === "Retained unknown body\n " && button(form(), "Save").disabled === true && calls.length === beforeReplay && contains(panel(), "Ask staff to verify the stored guide") && !contains(panel(), "Couldn't do that"));
    click(form(), "Cancel"); click(panel(), "Open draft editor");
    c.ok("fold/reopen cannot release an unconfirmed creation hold", input(form(), titlePlaceholder).value === "Unconfirmed exact draft" && button(form(), "Save").disabled === true && calls.length === beforeReplay);

    let rowProps: Props = elements(panel(), "ResourceRow")[0].props;
    const rowComponent = elements(panel(), "ResourceRow")[0].type as (p: Props) => unknown;
    const renderRow = mountHooks(() => rowComponent(rowProps));
    const rowTree = () => { rowProps = elements(panel(), "ResourceRow")[0].props; return renderRow(); };
    let editProps: Props = elements(rowTree(), "ResourceForm")[0].props;
    const editType = elements(rowTree(), "ResourceForm")[0].type as (p: Props) => unknown;
    const renderEdit = mountHooks(() => editType(editProps));
    const editForm = () => { editProps = elements(rowTree(), "ResourceForm")[0].props; return renderEdit(); };
    click(rowTree(), "Edit"); type(body(editForm()), "Unsaved existing guide\n Exact body "); click(rowTree(), "Close"); click(rowTree(), "Edit");
    c.ok("existing Close/Edit preserves the mounted unsaved body and existing identity/sort/owner", body(editForm()).value === "Unsaved existing guide\n Exact body " && editProps.initial === row && elements(editForm(), "select")[3].props.value === "owner");
    result = deferred(); const staleClose = button(rowTree(), "Close").onClick as () => void; click(editForm(), "Save"); staleClose(); click(editForm(), "Cancel");
    c.ok("existing save keeps the editor open while pending and targets only its exact row", button(editForm(), "Cancel").disabled === true && button(rowTree(), "Close").disabled === true && calls.at(-1)?.id === row.id && calls.at(-1)?.input?.sortOrder === 9 && calls.at(-1)?.input?.body === "Unsaved existing guide\n Exact body ");
    result.resolve({ ok: false, outcome: "unknown", message: "A guide needs a title." });
    await until(() => contains(rowTree(), "Save guide “Original guide” was not confirmed"));
    c.ok("unknown returned failure blocks update/review/publication instead of trusting message strings", body(editForm()).value === "Unsaved existing guide\n Exact body " && button(editForm(), "Save").disabled === true && button(rowTree(), "Still accurate").disabled === true && button(rowTree(), "Publish").disabled === true && contains(rowTree(), "It may already have been applied"));
    const checks = elements(rowTree(), "ResourceReceipt").map((e) => (e.type as (p: Props) => unknown)(e.props));
    c.ok("unknown recovery opens only a read-only separate guide tab and leaves draft in place", elements(checks, "a").some((e) => e.props.href === "/content/resources" && e.props.target === "_blank" && e.props.rel === "noopener noreferrer"));
    const nonOwner = mountHooks(() => rowComponent({ ...rowProps, isOwner: false }));
    c.ok("staff publication visibility is unchanged for non-owners", !elements(nonOwner(), "button").some((e) => contains(e.props.children, "Publish")));
    const cleanParent = mountHooks(() => ResourcesAdminPanel(props));
    let cleanRowData = row;
    const cleanRow = mountHooks(() => rowComponent({ ...elements(cleanParent(), "ResourceRow")[0].props, r: cleanRowData }));
    let cleanFormProps = elements(cleanRow(), "ResourceForm")[0].props;
    const cleanFormRender = mountHooks(() => editType(cleanFormProps));
    const cleanForm = () => { cleanFormProps = elements(cleanRow(), "ResourceForm")[0].props; return cleanFormRender(); };
    click(cleanRow(), "Edit"); type(input(cleanForm(), titlePlaceholder), " Normalized saved title "); type(body(cleanForm()), "Confirmed existing markdown\n ");
    result = deferred(); click(cleanForm(), "Save"); result.resolve({ ok: true, outcome: "confirmed", message: "Saved exact existing guide." });
    await until(() => contains(cleanRow(), "Saved exact existing guide"));
    c.ok("confirmed existing save retains its submitted words while refreshed props are still old", input(cleanForm(), titlePlaceholder).value === " Normalized saved title " && body(cleanForm()).value === "Confirmed existing markdown\n ");
    cleanRowData = { ...row, title: "Normalized saved title", body: "Confirmed existing markdown\n " };
    cleanForm();
    c.ok("matching refreshed props establish the confirmed normalized baseline without losing the exact body", input(cleanForm(), titlePlaceholder).value === "Normalized saved title" && body(cleanForm()).value === "Confirmed existing markdown\n " && !contains(cleanForm(), "The stored guide changed"));
    cleanRowData = { ...cleanRowData, body: "New stored guide while local editor is unchanged" }; cleanForm();
    c.ok("an unchanged folded editor accepts current server fields after refresh", body(cleanForm()).value === cleanRowData.body);
    click(cleanRow(), "Edit"); type(body(cleanForm()), "New unsaved local words\n "); cleanRowData = { ...cleanRowData, body: "Other stored edit" }; cleanForm();
    c.ok("divergent prop refresh keeps unsaved local words and labels changed stored evidence", body(cleanForm()).value === "New unsaved local words\n " && contains(cleanForm(), "The stored guide changed while this editor kept your local text"));
    result = deferred(); click(cleanRow(), "Publish"); result.reject(new Error("publication response lost"));
    await until(() => contains(cleanRow(), "Publish guide “Normalized saved title” was not confirmed"));
    c.ok("lost publication receipt is caught and holds repeated toggle/review/update without a fake failure", button(cleanRow(), "Publish").disabled === true && button(cleanRow(), "Still accurate").disabled === true && button(cleanForm(), "Save").disabled === true && calls.at(-1)?.published === true && calls.at(-1)?.id === row.id && body(cleanForm()).value === "New unsaved local words\n ");

    // Model actual keyed reconciliation: moving to a different Section or
    // disappearing from rows destroys both child hook mounts, while retaining
    // only the stable parent. The guide session must survive those removals.
    let movingProps = { ...props, readError: false };
    const movingParent = mountHooks(() => ResourcesAdminPanel(movingProps));
    let placement: string | undefined, movingRowProps: Props, movingFormProps: Props;
    let movingRowRender: (() => unknown) | undefined, movingFormRender: (() => unknown) | undefined;
    const movingRow = () => {
      const e = elements(movingParent(), "ResourceRow")[0];
      if (!e) { placement = undefined; movingRowRender = undefined; movingFormRender = undefined; return null; }
      const group = (e.props.r as ResourceRowUi).groupKey;
      if (!movingRowRender || placement !== group) {
        placement = group; movingFormRender = undefined;
        movingRowRender = mountHooks(() => (e.type as (p: Props) => unknown)(movingRowProps));
      }
      movingRowProps = e.props;
      return movingRowRender();
    };
    const movingForm = () => {
      const e = elements(movingRow(), "ResourceForm")[0];
      if (!movingFormRender) movingFormRender = mountHooks(() => (e.type as (p: Props) => unknown)(movingFormProps));
      movingFormProps = e.props;
      return movingFormRender();
    };
    click(movingRow(), "Edit"); type(input(movingForm(), titlePlaceholder), "Moved guide exact draft"); type(body(movingForm()), "Moved local markdown\n Keep  exact words "); type(elements(movingForm(), "select")[0].props, "second");
    result = deferred(); const beforeMovingCall = calls.length; click(movingForm(), "Save");
    movingProps = { ...movingProps, rows: [{ ...row, groupKey: "second" }] };
    const movedPendingForm = movingForm();
    click(movedPendingForm, "Save"); click(movedPendingForm, "Cancel");
    c.ok("parent group reconciliation remounts children but retains exact draft/pending guard and actual counts", input(movingForm(), titlePlaceholder).value === "Moved guide exact draft" && body(movingForm()).value === "Moved local markdown\n Keep  exact words " && button(movingForm(), "Save").disabled === true && button(movingRow(), "Close").disabled === true && calls.length === beforeMovingCall + 1 && elements(movingParent(), "Section").some((e) => e.props.title === "Second group" && e.props.count === 1));
    result.reject(new Error("response lost after refreshed group move"));
    await until(() => contains(movingRow(), "Save guide “Moved guide exact draft” was not confirmed"));
    c.ok("old save callback settles the same retained guide session after remount and holds new row writes", body(movingForm()).value === "Moved local markdown\n Keep  exact words " && button(movingForm(), "Save").disabled === true && button(movingRow(), "Publish").disabled === true && button(movingRow(), "Still accurate").disabled === true && calls.length === beforeMovingCall + 1);
    movingProps = { ...movingProps, rows: [], readError: true }; movingRow();
    movingProps = { ...movingProps, rows: [{ ...row, groupKey: "second" }], readError: false };
    click(movingForm(), "Save");
    c.ok("failed-list removal and later restoration cannot discard same-tab words or unknown hold", input(movingForm(), titlePlaceholder).value === "Moved guide exact draft" && body(movingForm()).value === "Moved local markdown\n Keep  exact words " && button(movingForm(), "Save").disabled === true && contains(movingRow(), "was not confirmed") && calls.length === beforeMovingCall + 1);
    const failedPanel = mountHooks(() => ResourcesAdminPanel({ ...props, rows: [], staff: [], readError: true, staffReadError: true }));
    c.ok("read failure never renders false empty guides/group counts or missing-owner evidence", contains(failedPanel(), "Existing guides and publication counts are unknown") && contains(failedPanel(), "Owner choices could not be loaded") && !contains(failedPanel(), "No guides exist") && !contains(failedPanel(), "Nothing written for this group") && elements(failedPanel(), "Section").filter((e) => e.props.title !== "Write a guide").every((e) => e.props.count === undefined));
    const ownerErrorForm = mountHooks(() => editType({ ...editProps, busy: false, held: false, isPending: () => false, staff: [], staffReadError: true }));
    c.ok("failed owner list preserves existing owner value and labels it instead of clearing it", elements(ownerErrorForm(), "select")[3].props.value === "owner" && elements(ownerErrorForm(), "select")[3].props.disabled === true && contains(ownerErrorForm(), "Guide owner"));

    // Now load real server actions + guard functions against in-memory fakes.
    // No Prisma client is instantiated and no provider/network mutation exists.
    delete req.cache[actionFile];
    let refuseAuth = false, failWrite = false, failRead = false, ownerReadFail = false;
    let stored: { body: string; ownerAppUserId: string | null } | null = { body: "Real guide", ownerAppUserId: "owner" };
    const fakeWrites: { op: string; args: unknown }[] = [];
    stub(req.resolve("../../src/lib/prisma.ts"), { prisma: { portalResource: {
      findUnique: async ({ where }: { where: { id?: string; slug?: string } }) => { if (failRead) throw new Error("fixture list/read failure"); return where.slug ? null : stored; },
      create: async (args: unknown) => { fakeWrites.push({ op: "create", args }); if (failWrite) throw new Error("Unknown platform."); return { id: "confirmed-new", slug: "confirmed-new" }; },
      update: async (args: unknown) => { fakeWrites.push({ op: "update", args }); if (failWrite) throw new Error("Unknown platform."); return {}; },
      findMany: async () => { if (failRead) throw new Error("fixture guide-list failure"); return []; },
    }, appUser: { findMany: async () => [], findUnique: async () => ({ id: "staff", name: "Fixture staff", email: "fixture@example.invalid", role: "OWNER", status: "ACTIVE", permissions: null, teamMemberId: null, editorKey: null, notificationsSeenAt: null }) } } });
    stub(req.resolve("../../src/lib/auth/guards.ts"), { requireAdmin: async () => { if (refuseAuth) throw new Error("Forbidden"); }, requireOwner: async () => { if (refuseAuth) throw new Error("Owner required"); }, authEnforced: () => true });
    stub(req.resolve("../../src/lib/auth/session.ts"), { getSession: async () => ({ uid: "staff" }) });
    stub(req.resolve("../../src/lib/auth/access.ts"), { canAccess: () => true });
    stub(req.resolve("../../src/lib/programOwners.ts"), { staffChoices: async () => { if (ownerReadFail) throw new Error("fixture staff-list failure"); return [{ id: "owner", name: "Guide owner" }]; } });
    stub(req.resolve("../../src/lib/programMonitoring.ts"), { markReviewItemHandled: async () => {}, unmarkReviewItem: async () => {}, programReviewItems: async () => [] });
    const domain = await import("../../src/lib/portalResourcesAdmin");
    const realActions = await import("../../src/app/content/resources/actions");
    const valid: ResourceInput = { title: "Confirmed guide", groupKey: domain.RESOURCE_GROUPS[0].key, body: "Exact actual body\n ", platform: "general", deviceContext: "any", ownerAppUserId: "owner", linkedActions: ["prepare_session"], sortOrder: 9 };
    const invalids = [{ ...valid, title: "" }, { ...valid, groupKey: "invalid" }, { ...valid, body: " " }, { ...valid, platform: "invalid" }, { ...valid, deviceContext: "invalid" }];
    const validation = [];
    for (const invalid of invalids) validation.push(await realActions.createResourceAction(invalid));
    c.ok("all existing input guards return typed refused before any fake write", validation.every((r) => !r.ok && r.outcome === "refused") && fakeWrites.length === 0 && validation.map((r) => r.message).join("|") === "A guide needs a title.|Pick one of the four resource groups.|A guide needs a body — an empty guide is a placeholder, and placeholders are not published.|Unknown platform.|Unknown device context.");
    let marked = false;
    try { await domain.updateResource("exact-guide", invalids[0]); } catch (error) { marked = error instanceof domain.ResourceWriteRefusedError; }
    c.ok("domain validation carries a specific refusal marker without changing order/messages", marked && fakeWrites.length === 0);
    const publishRefusals = [];
    stored = null; publishRefusals.push(await realActions.publishResourceAction("exact-guide", true));
    stored = { body: "TODO finish this", ownerAppUserId: null }; publishRefusals.push(await realActions.publishResourceAction("exact-guide", true));
    stored = { body: "Finished guide", ownerAppUserId: null }; publishRefusals.push(await realActions.publishResourceAction("exact-guide", true));
    c.ok("publish notfound/body/owner checks are refused in the same order before writes", publishRefusals.every((r) => r.outcome === "refused") && fakeWrites.length === 0 && publishRefusals[0].message === "Guide not found." && publishRefusals[1].message.includes("placeholder") && publishRefusals[2].message.includes("owner"));
    refuseAuth = true;
    const authResults = await Promise.all([realActions.createResourceAction(valid), realActions.updateResourceAction("exact-guide", valid), realActions.publishResourceAction("exact-guide", true), realActions.reviewResourceAction("exact-guide")]);
    c.ok("existing office/owner auth denials are refused before all resource writes", authResults.every((r) => !r.ok && r.outcome === "refused") && fakeWrites.length === 0);
    refuseAuth = false; stored = { body: "Finished guide", ownerAppUserId: "owner" };
    const confirmed = await Promise.all([realActions.createResourceAction(valid), realActions.updateResourceAction("exact-guide", valid), realActions.publishResourceAction("exact-guide", false), realActions.reviewResourceAction("exact-guide")]);
    const newData = (fakeWrites.find((write) => write.op === "create")!.args as { data: { published: boolean; body: string; sortOrder: number } }).data;
    c.ok("successful existing actions report confirmed while new guides still write draft/exact body/order", confirmed.every((r) => r.ok && r.outcome === "confirmed") && fakeWrites.length === 4 && newData.published === false && newData.body === valid.body && newData.sortOrder === 9);
    failWrite = true;
    const ambiguous = await realActions.updateResourceAction("exact-guide", valid);
    c.ok("untyped DB failure with validation-identical words remains unknown", !ambiguous.ok && ambiguous.outcome === "unknown" && ambiguous.message === "Unknown platform.");
    failWrite = false;
    const cache = req("next/cache") as { revalidatePath: () => void };
    const originalRevalidate = cache.revalidatePath;
    cache.revalidatePath = () => { throw new Error("fixture post-write revalidation failure"); };
    const beforePostWrite = fakeWrites.length;
    const postWrite = await realActions.createResourceAction(valid);
    cache.revalidatePath = originalRevalidate;
    c.ok("post-write response failure reports unknown despite one completed fake creation", postWrite.outcome === "unknown" && fakeWrites.length === beforePostWrite + 1);
    const backfill = await realActions.markReviewItemAction("record", "checked", "Exact judgment");
    c.ok("backfill action receipts remain unchanged outside resource outcome annotations", backfill.ok && backfill.outcome === undefined);
    const { default: Page } = await import("../../src/app/content/resources/page");
    failRead = true; ownerReadFail = true;
    const failurePage = await Page({ searchParams: Promise.resolve({}) });
    const failureProps = elements(failurePage, "ResourcesAdminPanel")[0].props;
    c.ok("real page passes separate guide/staff failure evidence to the panel", failureProps.readError === true && failureProps.staffReadError === true && (failureProps.rows as unknown[]).length === 0 && (failureProps.staff as unknown[]).length === 0);
    failRead = false; ownerReadFail = false;
    const emptyPage = await Page({ searchParams: Promise.resolve({}) });
    const emptyProps = elements(emptyPage, "ResourcesAdminPanel")[0].props;
    c.ok("confirmed empty list is distinct from failed reads and retains routes", emptyProps.readError === false && emptyProps.staffReadError === false && (emptyProps.rows as unknown[]).length === 0 && elements(emptyPage, "$href").filter((e) => String(e.props.href).startsWith("/content/resources")).map((e) => e.props.href).join() === "/content/resources,/content/resources?view=backfill");
    c.ok("resource recovery test uses only in-memory actions and makes no network/provider request", fence.blocked.length === 0);
    c.summary();
  } finally {
    for (const [file, original] of originals) { if (original) req.cache[file] = original; else delete req.cache[file]; }
    fence.restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
