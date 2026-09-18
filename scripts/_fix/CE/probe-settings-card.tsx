// READ-ONLY (no database). Group CE / C1, the client half: render the REAL
// coverage card and read back the sentence under the hour boxes.
//
// Run with:  npx tsx scripts/_fix/CE/probe-settings-card.tsx
// The "use server" actions module the card imports is stubbed; the useEffect
// that fetches the on-call roster does not run during server rendering, so no
// action is invoked.
/* eslint-disable @typescript-eslint/no-require-imports */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InternalAlertRules } from "../../../src/lib/settings";

const Mod = require("module");
const load = Mod._load;
const noop = async () => ({ ok: false, message: "probe: no action is invoked here" });
Mod._load = function (request: string, ...rest: unknown[]) {
  if (request === "@/app/settings/actions" || /[/\\]src[/\\]app[/\\]settings[/\\]actions(\.ts)?$/.test(request)) {
    return { saveTurnarounds: noop, saveInternalAlerts: noop, saveTextTemplates: noop, saveReviewRoomRules: noop, loadOnCallCandidates: async () => [] };
  }
  return load.call(this, request, ...rest);
};

const rules = (coverage: Partial<InternalAlertRules["coverage"]>, photos: Partial<InternalAlertRules["photosUndelivered"]> = {}): InternalAlertRules => ({
  uploadReminder: { enabled: true, hour: 19 },
  uploadChaser: { enabled: true, hour: 22 },
  photosUndelivered: { enabled: true, fromHour: 16, toHour: 19, lateAfterHours: 26, ...photos },
  rawVideoMissing: { enabled: true },
  kyleDigests: { enabled: true },
  coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null, ...coverage },
});

async function main() {
  const { InternalAlertSettings } = await import("../../../src/components/settings/OperatingRules");
  const cases: { name: string; r: InternalAlertRules }[] = [
    { name: "9am -> 6pm (the live rule)", r: rules({}) },
    { name: "6pm -> 9am (what Jordan typed for evening cover)", r: rules({ fromHour: 18, toHour: 9 }) },
    { name: "12pm -> 12pm", r: rules({ fromHour: 12, toHour: 12 }) },
    { name: "photos alert window 7pm -> 4pm", r: rules({}, { fromHour: 19, toHour: 16 }) },
  ];
  for (const c of cases) {
    const html = renderToStaticMarkup(React.createElement(InternalAlertSettings, { initial: c.r }));
    // JSX turns &rsquo; into a real ’ before React ever sees it, so normalise
    // the curly quotes as well as the entities the renderer does escape.
    const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#x?[0-9a-f]+;/gi, "'").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
    // Every sentence the card prints about a window, wherever it sits.
    const said: string[] = [];
    const ok = /Somebody is on .*?period\./.exec(text);
    if (ok) said.push(ok[0]);
    for (let i = text.indexOf("can't be saved"); i >= 0; i = text.indexOf("can't be saved", i + 1)) {
      said.push(text.slice(Math.max(0, i - 60), i + 170));
    }
    console.log(`${c.name}`);
    for (const s of said) console.log(`   "${s.trim()}"`);
    console.log("");
  }
}
main();
