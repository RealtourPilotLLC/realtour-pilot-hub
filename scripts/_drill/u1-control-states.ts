// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Native semantics and failure evidence; no database, action or provider calls.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";

installNextStubs();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
}
async function main() {
  const c = makeChecker(), fence = fenceFetch();
  try {
    const { Button, ActionLink } = await import("@/components/ui/Action");
    const { TextField } = await import("@/components/ui/FormField");
    const { SaveStatus } = await import("@/components/ui/SaveStatus");
    const { ControlStates } = await import("@/components/ui/ControlStates");
    const { PlanWithCall, PlanWithoutCall, CancelRequestButton } = await import("@/components/portal/PlanningChoice");
    const button = renderToStaticMarkup(createElement(Button, {}, "Example"));
    const submit = renderToStaticMarkup(createElement(Button, { type: "submit", name: "choice", value: "yes", formAction: "/fixture" }, "Submit"));
    c.ok("ordinary buttons do not accidentally submit surrounding forms", button.includes('type="button"'));
    c.ok("explicit submit preserves native form controls", submit.includes('type="submit"') && submit.includes('name="choice"') && submit.includes('formAction="/fixture"'));
    const pending = renderToStaticMarkup(createElement(Button, { busy: true, busyLabel: "Saving exact draft…" }, "Save"));
    c.ok("pending button refuses duplicate input and names the action", pending.includes("disabled") && pending.includes('aria-busy="true"') && pending.includes("Saving exact draft…"));
    const link = renderToStaticMarkup(createElement(ActionLink, { href: "/fixture?month=2026-10#review" }, "Review"));
    c.ok("navigation remains a native link with complete context", link.includes('href="/fixture?month=2026-10#review"') && !link.includes("<button"));
    const field = renderToStaticMarkup(createElement(TextField, { id: "fixture-note", label: "Note", defaultValue: "Retained exact words", hint: "Internal only", error: "Save refused", "aria-describedby": "context" }));
    c.ok("failed field retains input with its label and linked hint/error", field.includes('for="fixture-note"') && field.includes('value="Retained exact words"') && field.includes('aria-describedby="context fixture-note-hint fixture-note-error"') && field.includes('aria-invalid="true"') && field.includes('role="alert"'));
    const failed = renderToStaticMarkup(createElement(SaveStatus, { state: "error", message: "Retry the same request." }));
    const partial = renderToStaticMarkup(createElement(SaveStatus, { state: "partial", message: "One file is still unconfirmed." }));
    c.ok("failed and partial receipts cannot read as complete success", failed.includes('role="alert"') && failed.includes("Save not confirmed") && partial.includes("Partly saved") && partial.includes("unconfirmed"));
    const galleries = renderToStaticMarkup(createElement("div", {}, createElement(ControlStates, { prefix: "staff" }), createElement(ControlStates, { prefix: "client" })));
    const ids = [...galleries.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    c.ok("comparison palettes do not duplicate field or state anchor IDs", ids.length > 0 && new Set(ids).size === ids.length);
    const planning = renderToStaticMarkup(createElement("div", {}, createElement(PlanWithCall, { monthId: "fixture-month" }), createElement(PlanWithoutCall, { monthId: "fixture-month", callBooked: true }), createElement(CancelRequestButton, { requestId: "fixture-request", confirmed: true, selfBooked: true })));
    c.ok("planning and cancellation first paint keep distinct choices without submitting", planning.includes("Talk through topics on a call instead") && planning.includes("Choose my topics here instead") && planning.includes("Cancel session") && !planning.includes('type="submit"'));
    c.ok("rendering fixtures and migrated controls calls no provider", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
