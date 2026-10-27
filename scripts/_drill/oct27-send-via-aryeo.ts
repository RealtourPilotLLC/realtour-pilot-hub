// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: two of Jordan's Oct 27 2026 decisions on the office screens.
//
//   DRILL_PORT=5621 node scripts/_drill/run-all.cjs scripts/_drill/oct27-send-via-aryeo.ts
//
// #6 "Put the button back but collapsed and you click on 'send via aryeo
//    instead' and it shows the button". A branding video's Upload to Aryeo
//    instead sits inside a CLOSED "Send via Aryeo instead" fold, with one
//    line saying what the press does. The press itself is unchanged: the
//    same office API (/api/ops/video-destination), on both of the Video
//    Review Room's places (the portal row and "Going to the client's portal").
//
// #22 White text on green and amber badges uses the darker -action shades
//    (the same fix as the orange buttons): the -action tokens pass WCAG AA
//    (4.5:1) against white in every theme block, review pins for a Fixed
//    note use bg-success-action, and the job page's Request chip uses
//    --warning-action. No literal anywhere puts white text on bg-success or
//    bg-warning.
//
// No database; nothing leaves.
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {}, back() {} });
  navigation.useSearchParams = () => new URLSearchParams("");
  navigation.usePathname = () => "/";
}
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
/** The code without its comments. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
/** Visible words of a static render, entities decoded. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&rsquo;/g, "’").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function contrastOnWhite(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return 1.05 / (lum + 0.05);
}

async function main() {
  const c = makeChecker();
  try {
    c.head("#6 · Send via Aryeo instead, closed, then the button");
    const { ChooseAryeoDelivery } = await import("@/components/ops/ChooseAryeoDelivery");
    const html = renderToStaticMarkup(createElement(ChooseAryeoDelivery, { submissionId: "cmfixturesubmission01", fingerprint: "fp-fixture" }));
    const details = /<details\b[^>]*data-send-via-aryeo[^>]*>/.exec(html)?.[0] ?? "";
    c.ok("the control is a fold (details), closed by default", !!details && !/\sopen(=|\s|>)/.test(details), details);
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(html)?.[1] ?? "";
    c.ok("its label reads \"Send via Aryeo instead\"", text(summary) === "Send via Aryeo instead", text(summary));
    const after = html.slice(html.indexOf("</summary>"));
    c.ok("Upload to Aryeo instead is the button inside the fold (not on the row)", /<button\b[^>]*>Upload to Aryeo instead<\/button>/.test(after) && !/Upload to Aryeo instead/.test(html.slice(0, html.indexOf("</summary>"))));
    const line = text(after.slice(0, after.indexOf("<button")));
    c.ok("one line says what it does: portal to Aryeo, nothing sent until Upload to Aryeo and send", /from the client.s portal to the Aryeo listing/.test(line) && /Nothing is sent yet/.test(line) && /Upload to Aryeo and send/.test(line), line);
    c.ok("no em or en dash in the words", !/[–—]/.test(text(html)));

    const { PortalFinishing } = await import("@/components/ops/ReadyToSendCard");
    const row = { submissionId: "cmfixturesubmission02", projectId: "cmfixtureproject0001", street: "1 Fixture Ln", clientName: "Fixture Client", cutLabel: "Branding video 1", round: 2, state: "processing", approvedAtISO: new Date().toISOString(), waitingHours: 1, says: "In the Topaz pass.", deliveryDestination: "client-portal", canChooseAryeo: true, destinationFingerprint: "fp-2" };
    const finishing = renderToStaticMarkup(createElement(PortalFinishing, { rows: [row as any] }));
    c.ok("\"Going to the client's portal\" shows the fold, closed, with the button inside", finishing.includes("Going to the client") && /<details\b[^>]*data-send-via-aryeo/.test(finishing) && !/<details\b[^>]*data-send-via-aryeo[^>]*\sopen/.test(finishing) && (finishing.match(/Upload to Aryeo instead/g) ?? []).length === 1);

    const card = code(read("src/components/ops/ReadyToSendCard.tsx"));
    c.ok("both places in the room still draw it (the portal row and the 1080p list)", (card.match(/<ChooseAryeoDelivery /g) ?? []).length === 2);
    const comp = code(read("src/components/ops/ChooseAryeoDelivery.tsx"));
    c.ok("the press is the same office API: POST /api/ops/video-destination, read-only GET recovery", /\/api\/ops\/video-destination/.test(comp) && /request\("POST"\)/.test(comp) && /request\("GET"\)/.test(comp) && /confirmedAryeoDestination\(/.test(comp));
    c.ok("the destination's server rule is untouched (branding monthly videos only)", /videoStyleFor\(cut\.deliverable \?\? \{\}, \{ monthly: true \}\)\.key === "personal_branding"/.test(read("src/lib/videoDeliveryDestination.ts")));

    c.head("#22 · white text on green and amber: the darker shades");
    const css = read("src/app/globals.css");
    const values = (name: string) => [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))].map((m) => m[1]);
    for (const name of ["success-action", "warning-action"]) {
      const vs = values(name);
      c.ok(`--${name} passes AA (4.5:1) on white in every theme block`, vs.length >= 3 && vs.every((v) => contrastOnWhite(v) >= 4.5), vs.map((v) => `${v} ${contrastOnWhite(v).toFixed(2)}:1`).join(", "));
    }
    c.ok("the plain fills fail it, which is why they stay for dots and bars only", values("success").some((v) => contrastOnWhite(v) < 4.5) && values("warning").some((v) => contrastOnWhite(v) < 4.5));
    const types = code(read("src/components/review/types.ts"));
    c.ok("a Fixed note's numbered pin is white on bg-success-action", /FIXED:\s*"bg-success-action"/.test(/STATUS_BG[\s\S]*?\};/.exec(types)?.[0] ?? ""));
    const composer = code(read("src/components/project/ActivityComposer.tsx"));
    c.ok("the job page's chosen Request chip (white text) fills with --warning-action", /SPECIAL_REQUEST[\s\S]*?color:\s*"var\(--warning-action\)"/.test(composer) && !/#d97706/i.test(composer));

    const files: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(e.name)) files.push(p); } };
    walk(path.join(REPO, "src"));
    const literal = /["'`][^"'`\n]*["'`]/g;
    const bad = files.filter((f) => (code(fs.readFileSync(f, "utf8")).match(literal) ?? []).some((s) => /(^|[\s"'`])bg-(success|warning)(\/\d+)?([\s"'`]|$)/.test(s) && /(^|[\s"'`])text-(white|brand-fg)([\s"'`]|$)/.test(s))).map((f) => path.relative(REPO, f));
    c.ok(`no class string in ${files.length} source files puts white text on bg-success / bg-warning`, files.length > 300 && bad.length === 0, bad.join(", "));

    c.ok("nothing left the building", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(" | "));
    c.summary();
  } finally {
    fence.restore();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
