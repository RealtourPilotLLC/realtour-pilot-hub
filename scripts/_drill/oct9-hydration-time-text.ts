// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: OCT 9 2026 — THE SERVER AND THE BROWSER PRINT THE SAME TIME TEXT.
//
// The error tracker caught React #418 (hydration mismatch) for Jordan on Home
// (3×) and in the Review Room cut workspace (4×), every report from Safari
// (its "fn@url" stack frames), all between 5 PM and midnight ET. A client
// component's text is rendered twice — by Node on Vercel (UTC) and by the
// browser while hydrating — and React throws the page's tree away when the two
// differ. This drill runs the shipped code both ways:
//
//   1  SAFARI'S ENGINE. The real src/lib/datetime.ts, transpiled, runs inside
//      JavaScriptCore (osascript -l JavaScript — the engine and ICU Safari
//      uses on this Mac) and must print exactly what Node prints, for every
//      helper the client trees use, at the evening instant of the reports and
//      on both DST changeovers. The OLD one-call date+time format is run too,
//      to show the cause: Node "Thu, Oct 8, 7:30 PM", Safari "Thu, Oct 8 at
//      7:30 PM". (Skipped, visibly, on a machine without osascript.)
//   2  TIME ZONE. The actual client components that print times on Home
//      (ReadyToSendCard's "last successful check", DeliveryBoardView's due,
//      shot and upload lines) render the same HTML with the process in UTC (the
//      server) and in America/New_York (Jordan's browser), clock pinned at
//      2026-10-08 23:30Z — after the UTC day has rolled, before ET's has.
//   3  THE CLOCK. DeliveryBoardView rendered at the server's moment and again
//      two minutes later (the hydration), with a shoot starting in between:
//      the same HTML, because the view measures against the board's asOf.
//   4  THE GUARD. Every "use client" module reachable from the root layout,
//      Home and /review/[id]: no date/time Intl call without an explicit
//      timeZone, no single call asking for a date AND a time, no bare
//      toLocaleString(), and no clock read (new Date() / Date.now()) except
//      the reviewed ones listed below with why each is safe.
//
// Pure: no database, no network.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fenceFetch, makeChecker } from "./_harness";

const ROOT = path.resolve(__dirname, "..", "..");
const c = makeChecker();
const fence = fenceFetch(() => null);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
let offset = 0;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const setClock = (iso: string) => { offset = RealDate.parse(iso) - RealDate.now(); };
const inZone = <T,>(tz: string, fn: () => T): T => {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
};

const REPORT_INSTANT = "2026-10-08T23:30:00Z"; // 7:30 PM EDT, Oct 9 in UTC
const INSTANTS = [REPORT_INSTANT, "2026-10-09T04:14:05Z", "2026-03-08T06:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-12-31T23:59:00Z"];

async function main() {
  const dt = await import("@/lib/datetime");
  const attribution = await import("@/lib/reviewAttribution");

  // =========================================================================
  c.head("1 · SAFARI'S ENGINE (JavaScriptCore) PRINTS WHAT NODE PRINTS");
  {
    const osascript = ["/usr/bin/osascript"].find((p) => fs.existsSync(p));
    if (!osascript) {
      console.log("  NOTE osascript is not on this machine — the cross-engine half is skipped (it runs on the Mac)");
    } else {
      const esbuild = await import("esbuild");
      const src = fs.readFileSync(path.join(ROOT, "src/lib/datetime.ts"), "utf8");
      const js = esbuild.transformSync(src, { loader: "ts", format: "iife", globalName: "DT", target: "es2019" }).code;
      const helpers = ["etDateTime", "etTime", "etDate", "etMonthDay", "etDateYear", "etFullDate", "etDayKey"] as const;
      const OLD_ONE_CALL = { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as const;
      const program = `${js}
var instants = ${JSON.stringify(INSTANTS)};
var helpers = ${JSON.stringify(helpers)};
var out = instants.map(function (iso) {
  var d = new Date(iso);
  var row = {};
  helpers.forEach(function (h) { row[h] = DT[h](d); });
  row.oldOneCall = new Intl.DateTimeFormat("en-US", ${JSON.stringify(OLD_ONE_CALL)}).format(d);
  return row;
});
JSON.stringify(out);`;
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oct9-jsc-")), "datetime-jsc.js");
      fs.writeFileSync(file, program);
      let jsc: Record<string, string>[] = [];
      try {
        jsc = JSON.parse(execFileSync(osascript, ["-l", "JavaScript", file], { encoding: "utf8" }).trim()) as Record<string, string>[];
      } catch (e) {
        c.ok("JavaScriptCore ran the shipped datetime.ts", false, e instanceof Error ? e.message.slice(0, 200) : String(e));
      }
      if (jsc.length === INSTANTS.length) {
        const diffs: string[] = [];
        INSTANTS.forEach((iso, i) => {
          const d = new RealDate(iso);
          for (const h of helpers) {
            const node = (dt as unknown as Record<string, (x: Date) => string>)[h](d);
            if (node !== jsc[i][h]) diffs.push(`${h}(${iso}): node ${JSON.stringify(node)} vs safari ${JSON.stringify(jsc[i][h])}`);
          }
        });
        c.ok("every datetime helper prints the same text in Node and in Safari's engine", diffs.length === 0, diffs.slice(0, 4).join(" | "));
        const nodeOld = new Intl.DateTimeFormat("en-US", OLD_ONE_CALL).format(new RealDate(REPORT_INSTANT));
        console.log(`  (the cause, for the record: one Intl call for date + time → node ${JSON.stringify(nodeOld)} · safari ${JSON.stringify(jsc[0].oldOneCall)})`);
        c.ok("…and etDateTime at the reports' evening instant reads 'Thu, Oct 8, 7:30 PM' in both", dt.etDateTime(new RealDate(REPORT_INSTANT)) === "Thu, Oct 8, 7:30 PM" && jsc[0].etDateTime === "Thu, Oct 8, 7:30 PM", `${jsc[0].etDateTime}`);
      }
    }
    // The Review Room's note and verdict times are these helpers.
    const at = new RealDate(REPORT_INSTANT);
    c.ok("the Review Room's byLine / whenET are etDateTime (so the check above covers them)", attribution.whenET(at) === dt.etDateTime(at) && attribution.byLine("Kyle", at) === `Kyle · ${dt.etDateTime(at)}`, attribution.byLine("Kyle", at));
    c.ok("no narrow / thin / no-break space ever reaches the page", INSTANTS.every((iso) => !/[   ]/.test(dt.etDateTime(new RealDate(iso)) + dt.etTime(new RealDate(iso)))));
  }

  // =========================================================================
  c.head("2 · THE SAME HTML WITH THE PROCESS IN UTC (VERCEL) AND IN NEW YORK (THE BROWSER)");
  setClock(REPORT_INSTANT);
  // The drill's next/navigation stub refuses useRouter; these components only
  // keep the router for their buttons, which a static render never presses.
  const nav = createRequire(__filename)("next/navigation") as Record<string, unknown>;
  nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} });
  const { ReadyToSendCard } = await import("@/components/ops/ReadyToSendCard");
  const { DeliveryBoardView } = await import("@/components/tracker/DeliveryBoardView");
  type Board = Parameters<typeof DeliveryBoardView>[0]["board"];
  type ReadyBoard = Parameters<typeof ReadyToSendCard>[0]["board"];
  const readyBoard = {
    ready: [], rendering: [], needsFinishing: [], notTold: [],
    followUpChecks: { needsFinishing: null, notTold: "2026-10-08T23:29:00.000Z" },
    followUpLastSuccess: { needsFinishing: "2026-10-08T22:05:00.000Z", notTold: null },
  } as unknown as ReadyBoard;
  const shoot = new RealDate("2026-10-08T23:31:00Z"); // starts one minute after the server reads the board
  const job = {
    id: "job1", title: "12 Main St", address: null, client: "Drill Client", status: "SCHEDULED", shootDate: shoot,
    photographer: "James", dueAt: new RealDate("2026-10-09T21:00:00Z"), dueTierLabel: "Standard", dueFor: null,
    settled: false, overdue: false, reopened: false, revisionAskedAt: null, deliveredAt: null,
    blocker: "awaiting_upload", blockerLabel: "Awaiting upload", notes: null, items: [{ title: "Photos", quantity: 1, tierLabel: "Standard", dueAt: new RealDate("2026-10-09T21:00:00Z") }],
    photos: "none", video: "none",
    media: { photos: { liveOnAryeo: 0, rawInDropbox: 0, ordered: true }, video: { liveOnAryeo: 0, rawInDropbox: 0, ordered: true }, known: false, checkedAt: new RealDate("2026-10-08T20:00:00Z"), reason: "stale" },
  };
  const board = { today: [job], tomorrow: [], upcoming: [], delivered: [], overdueCount: 0, asOf: new RealDate(REPORT_INSTANT).toISOString() } as unknown as Board;
  {
    const readyUtc = inZone("UTC", () => renderToStaticMarkup(createElement(ReadyToSendCard, { board: readyBoard })));
    const readyNy = inZone("America/New_York", () => renderToStaticMarkup(createElement(ReadyToSendCard, { board: readyBoard })));
    c.ok("Ready to send's 'last successful check' is the same text in both zones", readyUtc === readyNy, readyUtc === readyNy ? "" : `${/last successful check[^.<]*/.exec(readyUtc)?.[0]} vs ${/last successful check[^.<]*/.exec(readyNy)?.[0]}`);
    c.ok("…and says the ET time, marked ET", /last successful check Thu, Oct 8, 6:05 PM ET/.test(readyNy), /last successful check[^.<]*/.exec(readyNy)?.[0]);

    const boardUtc = inZone("UTC", () => renderToStaticMarkup(createElement(DeliveryBoardView, { board })));
    const boardNy = inZone("America/New_York", () => renderToStaticMarkup(createElement(DeliveryBoardView, { board })));
    c.ok("the delivery board's due / shot / upload lines are the same HTML in both zones", boardUtc === boardNy);
    c.ok("…and its days are ET days (Thu Oct 8's evening shoot, not UTC's Fri Oct 9)", boardNy.includes("Shot Thu, Oct 8") && boardNy.includes("Fri, Oct 9"), /Shot [^<]*/.exec(boardNy)?.[0]);
  }

  // =========================================================================
  c.head("3 · THE SERVER'S MOMENT, NOT THE HYDRATION'S");
  {
    setClock(REPORT_INSTANT);
    const server = renderToStaticMarkup(createElement(DeliveryBoardView, { board }));
    setClock("2026-10-08T23:32:00Z"); // two minutes on — the shoot started in between
    const hydration = renderToStaticMarkup(createElement(DeliveryBoardView, { board }));
    c.ok("a shoot starting between the render and the hydration prints the same upload line", server === hydration, server === hydration ? "" : "the upload line moved with the browser's clock");
    c.ok("…measured at the board's read, the shoot has not happened yet ('not checked', not 'nothing yet')", server.includes("not checked") && !server.includes("nothing yet"));
    const later = { ...board, asOf: "2026-10-08T23:32:00.000Z" } as unknown as Board;
    c.ok("…and the next refresh, read after the shoot began, says 'nothing yet'", renderToStaticMarkup(createElement(DeliveryBoardView, { board: later })).includes("nothing yet"));
  }

  // =========================================================================
  c.head("4 · THE GUARD — every client module under the layout, Home and /review/[id]");
  {
    // Reviewed clock reads: each one never takes part in hydration.
    const REVIEWED_CLOCK_READS: Record<string, string> = {
      "src/components/NotificationsBell.tsx": "timeago() formats rows that are fetched after mount; seenAt comparisons run on fetched rows",
      "src/components/day/FinishedList.tsx": "dayLabel() renders only inside the list a click opens — never in the server HTML",
      "src/components/review/VerdictReceipts.tsx": "inside a useEffect (the fade timers)",
      "src/components/review/verdictReceiptStore.ts": "written from event handlers; the server snapshot is always empty",
      "src/lib/datetime.ts": "helpers that take an explicit date from their callers; the today/year defaults are not used by these client trees",
    };
    const files = clientModules(["src/app/layout.tsx", "src/app/page.tsx", "src/app/review/[id]/page.tsx"]);
    c.ok("the walk found the trees (the layout's shell, Home's cards, the Review Room panel)", ["src/components/Shell.tsx", "src/components/ops/ReadyToSendCard.tsx", "src/components/tracker/DeliveryBoardView.tsx", "src/components/review/CutReviewPanel.tsx"].every((f) => files.includes(f)), `${files.length} modules`);
    const noZone: string[] = [];
    const oneCall: string[] = [];
    const bare: string[] = [];
    const clock: string[] = [];
    for (const rel of files) {
      const src = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      for (const call of calls(src, /(new Intl\.DateTimeFormat|\.toLocaleDateString|\.toLocaleTimeString|\.toLocaleString)\(/g)) {
        const where = `${rel}:${call.line}`;
        if (call.callee === ".toLocaleString" && call.args.trim() === "") { bare.push(where); continue; }
        const isDateCall = call.callee !== ".toLocaleString" || /weekday|month|day|hour|minute|year|dateStyle|timeStyle/.test(call.args);
        if (!isDateCall) continue; // a number's toLocaleString("en-US")
        if (!/timeZone/.test(call.args)) noZone.push(where);
        // datetime.ts's ET_PARTS reads the wall clock as PARTS for offset
        // arithmetic (hourCycle h23, formatToParts) — never printed.
        const partsOnly = rel === "src/lib/datetime.ts" && /hourCycle: "h23"/.test(call.args);
        if (!partsOnly && /\b(hour|minute|timeStyle)\b/.test(call.args) && /\b(weekday|day|month|year|dateStyle)\b/.test(call.args)) oneCall.push(where);
      }
      if (/new Date\(\s*\)|Date\.now\(\)/.test(src) && !REVIEWED_CLOCK_READS[rel]) clock.push(rel);
    }
    c.ok("every date/time format names its time zone", noZone.length === 0, noZone.join(", "));
    c.ok("no single call asks for a date AND a time (Node and Safari join them differently)", oneCall.length === 0, oneCall.join(", "));
    c.ok("no bare toLocaleString() (the machine's locale and zone)", bare.length === 0, bare.join(", "));
    c.ok("no unreviewed clock read in a client module", clock.length === 0, clock.join(", "));
  }

  c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
  c.summary();
  process.exit(process.exitCode ?? 0);
}

// ---- the client-module walk ------------------------------------------------
function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const p = base + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}
/** Every module that runs in the BROWSER under these entry points: a "use
 *  client" file and everything it imports, stopping at "use server" files
 *  (those stay on the server and are called by reference). */
function clientModules(entries: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  const walk = (file: string, client: boolean) => {
    const src = fs.readFileSync(file, "utf8");
    const head = src.slice(0, 400);
    if (/^\s*["']use server["']/m.test(head)) return;
    const isClient = client || /^\s*["']use client["']/m.test(head);
    const key = `${file}|${isClient}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (isClient) out.add(path.relative(ROOT, file));
    const re = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (/^\s*(import|export)\s+type\s/.test(m[0])) continue;
      const r = resolveImport(m[1] ?? m[2], file);
      if (r) walk(r, isClient);
    }
  };
  for (const e of entries) walk(path.join(ROOT, e), false);
  return [...out].sort();
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p: string) => p + " ".repeat(m.length - p.length));
}
function calls(src: string, re: RegExp): { callee: string; args: string; line: number }[] {
  const out: { callee: string; args: string; line: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; i++; }
    // A formatter built once and used later: read its options from the call.
    out.push({ callee: m[1], args: src.slice(start, i - 1), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
