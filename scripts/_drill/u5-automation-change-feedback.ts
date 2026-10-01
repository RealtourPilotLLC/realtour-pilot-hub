// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Partial receipts and uncertain responses. All changes below are pure fakes.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";
import { attemptAutomationChange, transcriptBatchReadable } from "../../src/lib/automationChange";

installNextStubs();
async function main() {
  const c = makeChecker(), fence = fenceFetch();
  try {
    const calls: string[] = [];
    const ok = { ok: true, message: "Recorded choice." };
    const backlog = async () => { calls.push("backlog"); return ok; };
    const change = async () => { calls.push("switch"); return ok; };
    const ordinary = await attemptAutomationChange({ includeBacklog: false, setBacklog: backlog, setSwitch: change });
    c.ok("ordinary confirmation does not change the backlog", calls.join() === "switch" && ordinary.ok && !ordinary.uncertain);
    calls.length = 0;
    const combined = await attemptAutomationChange({ includeBacklog: true, setBacklog: backlog, setSwitch: change });
    c.ok("explicit backlog confirmation precedes the switch once", calls.join() === "backlog,switch" && combined.ok && !combined.uncertain);
    calls.length = 0;
    const refused = await attemptAutomationChange({ includeBacklog: true, setBacklog: async () => { calls.push("backlog"); return { ok: false, message: "Owner access required." }; }, setSwitch: change });
    c.ok("backlog refusal stops before switch mutation and retains its reason", calls.join() === "backlog" && !refused.ok && !refused.uncertain && refused.message === "Owner access required.");
    calls.length = 0;
    const partial = await attemptAutomationChange({ includeBacklog: true, setBacklog: backlog, setSwitch: async () => { calls.push("switch"); return { ok: false, message: "Pilot gate refuses this switch." }; } });
    c.ok("confirmed backlog followed by switch refusal names partial outcome and requires fresh batch", calls.join() === "backlog,switch" && !partial.ok && !partial.uncertain && partial.needsReload && partial.message.includes("backlog choice was saved") && partial.message.includes("Pilot gate refuses"));
    calls.length = 0;
    const lostBacklog = await attemptAutomationChange({ includeBacklog: true, setBacklog: async () => { calls.push("backlog"); throw new Error("response lost"); }, setSwitch: change });
    c.ok("unknown backlog response identifies only attempted stage and claims no saved backlog", calls.join() === "backlog" && !lostBacklog.ok && lostBacklog.uncertain && !lostBacklog.message.includes("was saved") && lostBacklog.message.includes("switch was not attempted") && lostBacklog.message.includes("Reload Settings"));
    calls.length = 0;
    const lostSwitch = await attemptAutomationChange({ includeBacklog: true, setBacklog: backlog, setSwitch: async () => { calls.push("switch"); throw new Error("response lost"); } });
    c.ok("unknown switch response retains known backlog receipt without blind retry", calls.join() === "backlog,switch" && !lostSwitch.ok && lostSwitch.uncertain && lostSwitch.message.includes("backlog choice was saved") && lostSwitch.message.includes("before trying again"));
    calls.length = 0;
    const lostDisable = await attemptAutomationChange({ includeBacklog: false, setBacklog: backlog, setSwitch: async () => { calls.push("switch"); throw new Error("response lost"); } });
    c.ok("uncertain disable cannot be reported as recorded off", calls.join() === "switch" && !lostDisable.ok && lostDisable.uncertain && lostDisable.message.includes("could not be confirmed"));
    c.ok("unread or failed transcript audiences refuse confirmation eligibility", !transcriptBatchReadable(null) && !transcriptBatchReadable({ error: "unavailable" }) && transcriptBatchReadable({ queued: 0 }));

    const { ProgramAutomationPanel } = await import("@/components/settings/ProgramAutomationPanel");
    const rows = [
      { key: "ai_runs", enabled: false, missing: false, enabledBy: null, enabledAtISO: null, lastRunAtISO: null, lastError: "Old model refusal", lastErrorAtISO: "2026-09-29T12:00:00Z" },
      { key: "script_drafting", enabled: true, missing: false, enabledBy: "Fixture owner", enabledAtISO: "2026-09-30T12:00:00Z", lastRunAtISO: null, lastError: null, lastErrorAtISO: null },
      { key: "transcript_jobs", enabled: false, missing: true, enabledBy: null, enabledAtISO: null, lastRunAtISO: null, lastError: null, lastErrorAtISO: null },
    ];
    const before = JSON.stringify(rows);
    const owner = renderToStaticMarkup(createElement(ProgramAutomationPanel, { rows, isOwner: true }));
    const staff = renderToStaticMarkup(createElement(ProgramAutomationPanel, { rows, isOwner: false }));
    c.ok("saved off, dependency-blocked on and unconfigured states stay distinct", owner.includes("configured but off") && owner.includes("on, but blocked") && owner.includes("never configured"));
    c.ok("off-switch failure stays explicitly historical", owner.includes("before it was turned off, its last run failed") && owner.includes("Old model refusal"));
    c.ok("non-owner first paint offers no switch controls", !staff.includes("Turn on</button>") && !staff.includes("Turn off</button>") && owner.includes("Turn off</button>"));
    c.ok("pure fake changes and panel render preserve rows and contact no provider", before === JSON.stringify(rows) && fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
