// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Exact partial-note receipts using fixture promises only.
// Oct 21 2026 (audit F9, Jordan): the card's "Email draft" tab is gone (the
// client page keeps ClientEmails' Gmail-thread draft), so the draft and
// clipboard receipts it carried went with it; the card is customer notes only.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";

installNextStubs();
async function main() {
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const workspace = await import("@/components/clients/ClientWorkspace");
    const { ClientWorkspace, confirmedCustomerNotes, customerNotesSaveReceipt } = workspace;
    const { SaveStatus } = await import("@/components/ui/SaveStatus");

    const priorNotes = "Fixture notes previously saved";
    const noteSubmission = "  Fixture submitted notes\nwith line breaks  ";
    c.ok("a known note refusal cannot advance the saved baseline", confirmedCustomerNotes(priorNotes, noteSubmission, { ok: false, syncError: null }) === priorNotes);
    c.ok("partial hub success preserves the confirmed submission despite provider failure", confirmedCustomerNotes(priorNotes, noteSubmission, { ok: false, syncError: "fixture provider failure" }) === noteSubmission.trim());
    c.ok("successful note receipts preserve the exact submitted line breaks", confirmedCustomerNotes(priorNotes, noteSubmission, { ok: true, syncError: null }) === noteSubmission.trim());
    const partial = customerNotesSaveReceipt({ ok: false, syncError: "fixture provider failure", message: "Saved in the hub, but it did NOT reach Aryeo: fixture provider failure" });
    const partialHtml = renderToStaticMarkup(createElement(SaveStatus, { ...partial, message: `${partial.message} Your current edits are still unsaved.` }));
    c.ok("a known partial note save names both confirmed and failed destinations", partial.state === "partial" && partialHtml.includes("Partly saved") && partialHtml.includes("Saved in the hub") && partialHtml.includes("did NOT reach Aryeo") && !partialHtml.includes("Save not confirmed") && partialHtml.includes("current edits are still unsaved"));
    const unknown = customerNotesSaveReceipt({ ok: false, syncError: null, message: "The save could not be confirmed." });
    const unknownHtml = renderToStaticMarkup(createElement(SaveStatus, unknown));
    c.ok("an unknown note-save response cannot inherit the earlier partial receipt", unknown.state === "error" && unknownHtml.includes('role="alert"') && unknownHtml.includes("Save not confirmed") && !unknownHtml.includes("Partly saved"));

    const props = { clientId: "fixture-client", notes: "Fixture retained note", notesSyncedAt: null, notesSyncError: null, aryeoLinked: true };
    const html = renderToStaticMarkup(createElement(ClientWorkspace, props));
    c.ok("the card is the customer notes alone: one textarea, no email draft", (html.match(/<textarea/g) ?? []).length === 1 && html.includes("Fixture retained note") && !html.includes("Email reply draft") && !html.includes("Email draft") && !html.includes("mailto:"));
    c.ok("the email-draft helpers are gone with the tab", !("attemptClientEmailDraft" in workspace) && !("copyClientEmailDraft" in workspace));
    c.ok("the note label describes linkage without claiming an unverified save", html.includes("Linked to Aryeo") && !html.includes("Saved to Aryeo"));
    c.ok("fixtures make no provider requests", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
