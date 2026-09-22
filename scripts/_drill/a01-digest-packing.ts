// ---------------------------------------------------------------------------
// DRILL: A01 — THE DIGEST AND THE RECORD AGREE (Sep 22 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx \
//       --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/a01-digest-packing.ts
//
// The Sep 21 audit: "Twelve approximately 210-character updates produced a
// 1,500-character outgoing body. The final update was absent, but all twelve
// rows retained their sent stamp and received a successful delivery log."
//
// packStaffDigest is pure, so the boundary cases run with no queue, no outbox
// and no provider. The flusher's half of the fix — unclaiming what did not fit,
// and logging only what was sent — is asserted by reading `count`, which is the
// number it slices by.
// ---------------------------------------------------------------------------
import { packStaffDigest } from "../../src/lib/notify";
import { HUB_SMS_PREFIX } from "../../src/lib/hubSms";

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const LIMIT = 1500;
const line = (n: number, len: number) => `Update ${n}: ` + "x".repeat(Math.max(0, len - `Update ${n}: `.length));

console.log("\n=== A01: a staff digest never claims a line it did not carry ===\n");

// THE AUDIT'S EXACT CASE. Twelve ~210-character updates.
{
  const lines = Array.from({ length: 12 }, (_, i) => line(i + 1, 210));
  const p = packStaffDigest(lines, LIMIT);
  ok("the body stays inside the limit", p.body.length <= LIMIT, `${p.body.length} chars`);
  ok("BEFORE: all twelve would have been marked sent — now fewer are carried", p.count < 12, `carried ${p.count} of 12`);
  ok("every carried line is present WHOLE", lines.slice(0, p.count).every((l) => p.body.includes(l)));
  ok("no line is present in part", lines.slice(p.count).every((l) => !p.body.includes(l.slice(0, 60))));
  ok("the header's count matches what is actually in the body", p.body.startsWith(`${HUB_SMS_PREFIX} — ${p.count} updates:`), p.body.slice(0, 40));
  // The proof that the OLD behaviour was a silent loss: the naive body is
  // longer than the limit, so slicing it would have cut a line in half.
  const naive = `${HUB_SMS_PREFIX} — ${lines.length} updates:\n` + lines.map((l) => `• ${l}`).join("\n");
  ok("BEFORE: the naive body really did overrun and would have been cut", naive.length > LIMIT, `${naive.length} chars`);
}

// One ordinary line.
{
  const p = packStaffDigest(["322 N 62nd St is back from the editor."], LIMIT);
  ok("a single short update sends whole, with the single-line prefix", p.count === 1 && p.body === `${HUB_SMS_PREFIX}: 322 N 62nd St is back from the editor.`);
  ok("  …and is not marked as summarised", p.summarisedOne === false);
}

// Two lines that fit.
{
  const p = packStaffDigest(["one thing", "another thing"], LIMIT);
  ok("two short updates both go", p.count === 2 && p.body.includes("one thing") && p.body.includes("another thing"));
}

// Exactly at the boundary: the largest k that fits is taken, not k-1.
{
  const lines = Array.from({ length: 6 }, (_, i) => line(i + 1, 240));
  const p = packStaffDigest(lines, LIMIT);
  const oneMore = `${HUB_SMS_PREFIX} — ${p.count + 1} updates:\n` + lines.slice(0, p.count + 1).map((l) => `• ${l}`).join("\n");
  ok("it takes as many complete lines as genuinely fit", p.count > 0 && (p.count === lines.length || oneMore.length > LIMIT), `carried ${p.count}`);
}

// ONE line longer than the whole budget. The audit asked for this explicitly:
// "Handle an oversized individual update explicitly… Do not silently cut off
// the middle of an instruction."
{
  const huge = "The client wants " + "a very long instruction ".repeat(120);
  const p = packStaffDigest([huge], LIMIT);
  ok("an oversized single update still sends something", p.count === 1 && p.body.length <= LIMIT);
  ok("  …and SAYS it was cut, with somewhere to go", p.summarisedOne === true && p.body.includes("open the hub to read it in full"));
  ok("  …rather than ending mid-sentence with no sign of it", !p.body.endsWith("instruction "));
}

// Nothing queued.
{
  const p = packStaffDigest([], LIMIT);
  ok("an empty queue packs to nothing", p.count === 0 && p.body === "");
}

// A tiny limit still produces something honest rather than throwing.
{
  const p = packStaffDigest(["a short update", "a second one"], 80);
  ok("a cramped limit still carries complete lines and counts them", p.body.length <= 80 && p.count >= 1, `${p.count} in ${p.body.length} chars`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
