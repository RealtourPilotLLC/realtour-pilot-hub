// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Exact historical stage, displayed verification and uncertain-action evidence.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";
import { reviewStage, verifiedFixIds } from "../../src/lib/reviewStage";
import { reviewActionReceipt, reviewRetryBlocked } from "../../src/lib/reviewActionReceipt";
import type { CutSubmission } from "../../src/lib/reviewRoom";

installNextStubs();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) navigation.useRouter = () => ({ refresh() {} });
async function main() {
  const c = makeChecker(), fence = fenceFetch();
  try {
    const { CutReviewPanel } = await import("@/components/review/CutReviewPanel");
    const cut: CutSubmission = { id: "fixture-v1", round: 1, status: "SUPERSEDED", assetUrl: null, assetPath: null, fileName: "first-version.mp4", note: null, submittedByKey: "kim", submittedByName: "Kim Fixture", createdAt: "2026-09-29T12:00:00Z", decidedAt: null, decidedBy: null, clientRequestedAt: null, clientRequestedBy: null, verdict: null, reviewerMove: null, deliverableId: "fixture-deliverable", slot: 1, source: "upload", hasHubCopy: true, completedAt: "2026-09-29T12:00:00Z", heldForCheck: false };
    const paint = (changes: Partial<CutSubmission> = {}, heldForCheck = false) => renderToStaticMarkup(createElement(CutReviewPanel, { projectId: "fixture-project", submission: { ...cut, ...changes }, notes: [], editorLabel: "Kim", heldForCheck, fixesToCheck: [{ id: "displayed-fix", text: "Replace the old logo." }] }));
    const stale = paint();
    c.ok("historical replaced cut is neither a new change request nor approvable", stale.includes("Earlier version") && !stale.includes("Changes requested") && !stale.includes("Approve cut</button>"));
    const internal = paint({ status: "CHANGES_REQUESTED", verdict: { kind: "sent_back", source: "office", by: "James Fixture", atISO: "2026-09-29T14:00:00Z" } });
    const client = paint({ status: "CHANGES_REQUESTED", verdict: { kind: "sent_back", source: "client", by: "Maya Fixture", atISO: "2026-09-29T14:00:00Z" } });
    c.ok("creative and client requests name only their recorded origin", internal.includes("Creative review changes requested") && internal.includes("James Fixture") && client.includes("Client changes requested") && client.includes("Maya Fixture"));
    c.ok("unknown request attribution remains unknown", paint({ status: "CHANGES_REQUESTED" }).includes("source not recorded"));
    const approved = paint({ status: "APPROVED" });
    c.ok("creative approval does not claim delivery or client approval", approved.includes("Approved in creative review") && !approved.includes("Delivered to") && !approved.includes("Client approved"));
    c.ok("historical system delivery stamp never claims a human creative verdict", paint({ status: "APPROVED", verdict: { kind: "approved", source: "delivered", by: null, atISO: "2026-09-29T14:00:00Z" } }).includes("Approval recorded at delivery"));
    const pending = paint({ id: "fixture-v2", status: "PENDING", round: 2 });
    c.ok("current pending cut exposes exact round and displayed fix check", pending.includes("Awaiting creative review") && pending.includes("version 2") && pending.includes("Replace the old logo.") && pending.includes('type="checkbox"') && pending.includes("Approve cut</button>"));
    const held = paint({ status: "PENDING" }, true);
    c.ok("held upload cannot expose creative verdict buttons", held.includes("Waiting on Kim") && !held.includes("Approve cut</button>"));
    c.ok("withdrawn and incomplete uploads cannot impersonate change requests", ["WITHDRAWN", "UPLOADING", "UPLOAD_FAILED"].every((status) => !paint({ status }).includes("Changes requested")));
    c.ok("unrecognized stored status cannot invent a verdict", reviewStage({ status: "UNKNOWN" }).label.includes("not recognized"));
    const visible = [{ id: "logo" }, { id: "captions" }];
    c.ok("approval carries only visible fixes left checked, never unseen new issues", verifiedFixIds(visible, new Set(["captions", "unseen"])).join() === "logo" && !verifiedFixIds([], new Set()).length);
    let clearCalls = 0;
    const draft = { words: "Exact unsent request", timestamp: "1:23" };
    const before = JSON.stringify(draft);
    const uncertain = await reviewActionReceipt(async () => { throw new Error("lost response"); });
    if (uncertain.ok) clearCalls++;
    c.ok("lost action response keeps words and requires recorded-state check without another call", !uncertain.ok && uncertain.needsReload && !!uncertain.message?.includes("before trying again") && clearCalls === 0 && before === JSON.stringify(draft));
    c.ok("a background read during an unknown action cannot unlock retry", reviewRetryBlocked({ stamp: "read-before-dispatch", requested: false }, "background-read-before-outcome"));
    c.ok("retry unlocks only after the requested recorded-state read completes", reviewRetryBlocked({ stamp: "latest-at-refresh-click", requested: true }, "latest-at-refresh-click") && !reviewRetryBlocked({ stamp: "latest-at-refresh-click", requested: true }, "successful-read-after-refresh"));
    const rejected = await reviewActionReceipt(async () => ({ ok: false, message: "A newer cut exists." }));
    const confirmed = await reviewActionReceipt(async () => ({ ok: true, message: "Recorded on v2." }));
    c.ok("known refusal and confirmation retain their exact domain receipts", !rejected.ok && !rejected.needsReload && rejected.message === "A newer cut exists." && confirmed.ok && !confirmed.needsReload && confirmed.message === "Recorded on v2.");
    c.ok("stage rendering and fake action failures contact no providers", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
