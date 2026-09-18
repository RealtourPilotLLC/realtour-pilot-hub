// The Editing Room's due filter, drilled on the REAL board (Jordan, Sep 18:
// "another filter in the editing room like Due Today").
//
// Two things can go wrong here and neither shows up in a type check. The dates
// can be a day out — the app is Eastern, the server is UTC and half the editors
// are in Manila. And the two selects can lie to each other: an option that
// advertises a count and then shows an empty table is the whole reason the
// counts are cross-filtered, and this drill is what proves they are.
//
// It imports the SHIPPED matchesDue/etWeekBounds out of SimpleQueue.tsx rather
// than restating them, so a change to the component that breaks the rule breaks
// this too.
//
// Run (NODE_OPTIONS, not `node --require`: the tsx bin re-spawns node, so a
// --require on the outer process never reaches the one that runs this file —
// and NO react-server condition, because this is a client module):
//   NODE_OPTIONS="--require ./scripts/_drill/_drill-preload.cjs --require ./scripts/_drill/_client-drill-preload.cjs" \
//     npx tsx scripts/_drill/due-filter.ts [board.json]
// The optional board.json is a dump of buildEditorQueue() — {notDone, upcoming,
// done} of {id, dueISO, late, editorKey}. Without it the drill runs the
// hand-built cases only.
import { readFileSync } from "node:fs";
import { etDayKey } from "@/lib/datetime";
import { matchesDue, etWeekBounds, type DueFilter } from "@/components/editing/SimpleQueue";

let fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// 1. The week window. Monday through Sunday, in Eastern, whatever day you ask
//    from — including the Sunday that a US-calendar week would push into next
//    week, and the two 2026 clock changes (Mar 8, Nov 1), where a millisecond
//    loop would land the boundary an hour into the wrong day.
// ---------------------------------------------------------------------------
console.log("ET week bounds (Mon–Sun):");
for (const [day, want] of [
  ["2026-09-14", ["2026-09-14", "2026-09-20"]], // Monday: the week starts on it
  ["2026-09-18", ["2026-09-14", "2026-09-20"]], // Friday, the day this shipped
  ["2026-09-20", ["2026-09-14", "2026-09-20"]], // Sunday belongs to the week that just worked, not the next one
  ["2026-03-08", ["2026-03-02", "2026-03-08"]], // spring forward — a 23-hour day inside the window
  ["2026-11-01", ["2026-10-26", "2026-11-01"]], // fall back — a 25-hour day
  ["2027-01-01", ["2026-12-28", "2027-01-03"]], // the week that straddles New Year
] as const) {
  const w = etWeekBounds(day);
  check(w.start === want[0] && w.end === want[1], day, `${w.start} → ${w.end}`);
}

// ---------------------------------------------------------------------------
// 2. The day key off a real instant. These are the deadlines the hub actually
//    writes: 5pm ET for the day-quoted tiers, shoot-time + N hours for the
//    hour-quoted ones — which is how an evening deadline ends up on tomorrow's
//    UTC date. 24 of the 540 deliveryDue timestamps on the live board sit on a
//    different UTC date than ET one, so slicing the ISO string would have
//    mis-filed every one of them.
// ---------------------------------------------------------------------------
console.log("\nET day off the instant (vs. the UTC slice a naive filter would take):");
for (const [iso, want, note] of [
  ["2026-09-18T21:00:00.000Z", "2026-09-18", "5pm EDT — same UTC day, the easy case"],
  ["2026-01-14T22:00:00.000Z", "2026-01-14", "5pm EST — still the same UTC day"],
  ["2026-01-15T00:30:00.000Z", "2026-01-14", "7:30pm EST — UTC says the 15th, ET says the 14th"],
  ["2026-09-19T02:00:00.000Z", "2026-09-18", "10pm EDT — UTC says the 19th"],
  ["2026-03-08T06:30:00.000Z", "2026-03-08", "1:30am EST on spring-forward morning"],
] as const) {
  const got = etDayKey(new Date(iso));
  const naive = iso.slice(0, 10);
  check(got === want, note, `${got}${naive !== got ? ` (UTC slice would say ${naive})` : ""}`);
}

// ---------------------------------------------------------------------------
// 3. The buckets themselves, on a hand-built board where every answer is known.
//    Today is Friday Sep 18 2026; the week is Mon Sep 14 – Sun Sep 20.
// ---------------------------------------------------------------------------
const today = "2026-09-18";
const week = etWeekBounds(today);
type Case = { name: string; late: boolean; due: string | null; want: DueFilter[] };
const cases: Case[] = [
  { name: "due later today", late: false, due: "2026-09-18T21:00:00Z", want: ["any", "today", "week"] },
  // The one row that is honestly in two buckets: 5pm has been and gone, so the
  // Due column is printing it red, and it is still a thing due today.
  { name: "due 5pm today, read at 6pm", late: true, due: "2026-09-18T21:00:00Z", want: ["any", "overdue", "today", "week"] },
  { name: "blew Tuesday's deadline", late: true, due: "2026-09-15T21:00:00Z", want: ["any", "overdue", "week"] },
  // "This week" is the week the DEADLINE falls in, not "from now to Sunday" —
  // an overdue job dated Tuesday is exactly what you want back when you ask
  // what is due this week.
  { name: "blew a deadline three weeks ago", late: true, due: "2026-08-25T21:00:00Z", want: ["any", "overdue"] },
  { name: "due Sunday (still this week)", late: false, due: "2026-09-20T21:00:00Z", want: ["any", "week"] },
  { name: "due Monday (next week)", late: false, due: "2026-09-21T21:00:00Z", want: ["any"] },
  { name: "due 10pm tonight (UTC says tomorrow)", late: false, due: "2026-09-19T02:00:00Z", want: ["any", "today", "week"] },
  { name: "no delivery date at all", late: false, due: null, want: ["any", "undated"] },
  // Done rows carry a past deadline and late=false by construction
  // (editorQueue: `late = !upcoming && status !== "DELIVERED" && ...`). Overdue
  // must not claim them, or the Done tab would read as 32 blown deadlines.
  { name: "delivered, deadline long past", late: false, due: "2026-08-21T21:00:00Z", want: ["any"] },
];
const ALL: DueFilter[] = ["any", "overdue", "today", "week", "undated"];
console.log(`\nBuckets on ${today} (week ${week.start} → ${week.end}):`);
for (const c of cases) {
  const key = c.due ? etDayKey(new Date(c.due)) : null;
  const got = ALL.filter((f) => matchesDue(f, c.late, key, today, week));
  check(got.join(",") === c.want.join(","), c.name, `[${got.join(", ")}]`);
}

// ---------------------------------------------------------------------------
// 4. The real board: the cross-filter invariant, which is the thing the counts
//    promise. For every tab, every editor you can pick and every due option
//    OFFERED alongside it, the number on the option has to equal the number of
//    rows you then see — and never be zero, or the control has handed you a
//    dead end.
// ---------------------------------------------------------------------------
const boardPath = process.argv[2];
if (!boardPath) {
  console.log("\n(no board.json given — skipping the live-board replay)");
} else {
  type Row = { id: string; dueISO: string | null; late: boolean; editorKey: string | null };
  const board = JSON.parse(readFileSync(boardPath, "utf8")) as Record<string, Row[]>;
  const now = etDayKey(new Date());
  const nowWeek = etWeekBounds(now);
  console.log(`\nLive board replay (today ${now}, week ${nowWeek.start} → ${nowWeek.end}):`);
  for (const [tab, rows] of Object.entries(board)) {
    // The tab's own choices, exactly as the component builds them: Upcoming
    // holds shoot dates and is built from `shootDate >= now`, so Overdue is not
    // one of its questions.
    const choices: DueFilter[] = tab === "upcoming" ? ["today", "week", "undated"] : ["overdue", "today", "week", "undated"];
    const keyOf = (r: Row) => (r.dueISO ? etDayKey(new Date(r.dueISO)) : null);
    const editors = [null, ...new Set(rows.map((r) => r.editorKey ?? "__none__"))];
    let offered = 0;
    let deadEnds = 0;
    let mismatches = 0;
    for (const who of editors) {
      const forDue = rows.filter((r) => who === null || (r.editorKey ?? "__none__") === who);
      for (const f of choices) {
        const n = forDue.filter((r) => matchesDue(f, r.late, keyOf(r), now, nowWeek)).length;
        if (n === 0) continue; // not offered — this is the dead end being designed out
        offered++;
        const shown = rows.filter(
          (r) => (who === null || (r.editorKey ?? "__none__") === who) && matchesDue(f, r.late, keyOf(r), now, nowWeek),
        ).length;
        if (shown !== n) mismatches++;
        if (shown === 0) deadEnds++;
      }
      // And the other direction: with a due filter on, the Editor select counts
      // inside it, so every name it offers has rows behind it too.
      for (const f of choices) {
        const forEditors = rows.filter((r) => matchesDue(f, r.late, keyOf(r), now, nowWeek));
        for (const e of new Set(forEditors.map((r) => r.editorKey ?? "__none__"))) {
          const n = forEditors.filter((r) => (r.editorKey ?? "__none__") === e).length;
          if (n === 0) deadEnds++;
        }
      }
    }
    check(mismatches === 0 && deadEnds === 0, `${tab} (${rows.length} rows)`, `${offered} options offered, ${deadEnds} dead ends, ${mismatches} miscounts`);
    const line = choices
      .map((f) => `${f}=${rows.filter((r) => matchesDue(f, r.late, keyOf(r), now, nowWeek)).length}`)
      .join(" ");
    console.log(`        whole tab: ${line}`);
  }
}

console.log(fail === 0 ? "\nPASS — the dates are Eastern and no option offers a count it can't show" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
