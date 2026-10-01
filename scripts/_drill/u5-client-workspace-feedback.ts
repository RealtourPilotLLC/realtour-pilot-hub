// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Exact draft, clipboard and partial-note receipts using fixture promises only.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";

installNextStubs();
async function main() {
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const {
      ClientWorkspace, attemptClientEmailDraft, finishClientEmailDraft,
      copyClientEmailDraft, clientEmailCopyFeedback, confirmedCustomerNotes, customerNotesSaveReceipt,
    } = await import("@/components/clients/ClientWorkspace");
    const { SaveStatus } = await import("@/components/ui/SaveStatus");
    const submitted = "Fixture reply before request";
    const newer = "Fixture reply with newer words and\nexact spacing.  ";
    let finish!: (reply: { ok: boolean; message: string; draft: string }) => void;
    let requestCount = 0;
    let settled = false;
    const delayed = attemptClientEmailDraft(() => {
      requestCount++;
      return new Promise((resolve) => { finish = resolve; });
    }).then((result) => { settled = true; return result; });
    await Promise.resolve();
    c.ok("pending AI work cannot claim an applied draft", !settled && requestCount === 1);
    finish({ ok: true, message: "Draft ready. Review before sending.", draft: "Fixture AI reply" });
    const response = await delayed;
    const retained = finishClientEmailDraft(newer, submitted, response);
    c.ok("late AI completion retains the exact newer words and spacing", retained.value === newer && retained.feedback?.message.includes("wasn't applied") === true);
    const applied = finishClientEmailDraft(submitted, submitted, response);
    c.ok("AI completion applies only to its unchanged request draft", applied.value === "Fixture AI reply" && applied.feedback?.message.includes("Review before sending") === true);
    const refusal = finishClientEmailDraft(newer, submitted, { ok: false, message: "Fixture AI configuration missing" });
    c.ok("a known refusal retains words and the actual explanation", refusal.value === newer && refusal.feedback?.ok === false && refusal.feedback.message === "Fixture AI configuration missing");
    const empty = finishClientEmailDraft(newer, newer, { ok: true, message: "Draft ready" });
    c.ok("an empty success-shaped response cannot replace text or claim a draft", empty.value === newer && empty.feedback?.ok === false && empty.feedback.message.includes("No AI draft"));
    let failedRequests = 0;
    const failure = await attemptClientEmailDraft(async () => { failedRequests++; throw new Error("fixture disconnected"); });
    const afterFailure = finishClientEmailDraft(newer, submitted, failure);
    c.ok("an unknown AI failure retains newer words with explicit failure feedback", afterFailure.value === newer && afterFailure.feedback?.ok === false && afterFailure.feedback.message.includes("Your words are still here"));
    c.ok("AI failure is not automatically retried", failedRequests === 1);

    let clipboardValue = "";
    let finishCopy!: () => void;
    let copied = false;
    const waitingCopy = copyClientEmailDraft(submitted, (value) => {
      clipboardValue = value;
      return new Promise((resolve) => { finishCopy = resolve; });
    }).then((receipt) => { copied = receipt.ok; return receipt; });
    await Promise.resolve();
    c.ok("clipboard success waits for the fixture write promise", !copied && clipboardValue === submitted);
    finishCopy();
    const receipt = await waitingCopy;
    c.ok("clipboard success identifies the exact submitted draft", receipt.ok && receipt.value === submitted && clientEmailCopyFeedback(receipt, submitted).message.includes("Draft copied"));
    c.ok("an older copy receipt cannot claim newer input was copied", clientEmailCopyFeedback(receipt, newer).message.includes("newer edits have not been copied"));
    let copyAttempts = 0;
    const denied = await copyClientEmailDraft(newer, async () => { copyAttempts++; throw new Error("fixture denied"); });
    c.ok("clipboard denial has an error receipt without retry or discarded input", !denied.ok && denied.value === newer && denied.message.includes("select and copy") && copyAttempts === 1);
    const unavailable = await copyClientEmailDraft(newer, () => { throw new Error("fixture clipboard unavailable"); });
    c.ok("an unavailable clipboard also yields a caught failure", !unavailable.ok && unavailable.value === newer);

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

    const props = {
      clientId: "fixture-client", hasPhone: false, email: "fixture@example.test", lastInbound: "Fixture question",
      notes: "Fixture retained note", notesSyncedAt: null, notesSyncError: null, aryeoLinked: true,
    };
    const html = renderToStaticMarkup(createElement(ClientWorkspace, props));
    c.ok("initial render mounts both draft sections, with Notes hidden rather than omitted", (html.match(/<textarea/g) ?? []).length === 2 && html.includes('hidden=""') && html.includes("Fixture retained note") && html.includes('aria-label="Email reply draft"'));
    c.ok("the note label describes linkage without claiming an unverified save", html.includes("Linked to Aryeo") && !html.includes("Saved to Aryeo"));
    c.ok("email remains a mail-app handoff, with no hub send control", html.includes("mailto:fixture@example.test?body=") && html.includes("Open in mail") && html.includes("the hub drafts, you send"));
    c.ok("fixtures make no provider requests", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
