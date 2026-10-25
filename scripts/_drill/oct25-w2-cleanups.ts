// Oct 25 2026 audit, wave 2: the small consolidations.
//   §G16 the inline ET day keys (toLocaleDateString("en-CA", ET)) became
//        lib/datetime etDayKey where the input is always a real date: the two
//        agree on every instant over 30 years (DST edges included); they
//        differ only on an invalid date ("Invalid Date" vs a RangeError), so
//        the copies fed a stored string (BulkPlanPanel, ProgramRolloutPanel's
//        end day) stay, and yourMonth's (a variable zone) is not ET.
// Disposable PGlite; nothing leaves.
// @drill-run: conditions=react-server
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const REPO = path.resolve(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5877) });
  const c = makeChecker();
  try {
    const { etDayKey, etMonthKey } = await import("@/lib/datetime");

    c.head("§G16 · one ET day key");
    const inline = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let n = 0, differ = 0;
    for (let t = Date.parse("2000-01-01T00:00:00Z"); t < Date.parse("2031-01-01T00:00:00Z"); t += 3_600_000 * 7 + 137) {
      n++;
      if (inline(new Date(t)) !== etDayKey(new Date(t))) differ++;
    }
    const edges = ["2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z", "2026-11-01T04:59:59Z", "2026-11-01T05:00:00Z", "2026-11-01T05:30:00Z", "2026-12-31T04:59:59Z", "2026-12-31T05:00:00Z"].map((s) => new Date(s));
    c.ok(`the inline key and etDayKey agree on ${n} instants and every DST / midnight edge`, differ === 0 && edges.every((d) => inline(d) === etDayKey(d)), `${differ} differ`);
    c.ok("…and the month key is its first seven characters", edges.every((d) => inline(d).slice(0, 7) === etMonthKey(d)));
    let threw = false;
    try { etDayKey(new Date(NaN)); } catch { threw = true; }
    c.ok("they differ on an invalid date only (why the stored-string copies stay)", inline(new Date(NaN)) === "Invalid Date" && threw);
    const moved = ["src/app/portal/actions.ts", "src/components/day/FinishedList.tsx", "src/lib/contentTopics.ts", "src/lib/notify.ts", "src/lib/commsBoard.ts", "src/lib/programDeskTasks.ts", "src/lib/uploadGaps.ts", "src/lib/photoDelivery/fixPolicy.ts"];
    c.ok("the replaced files hold no inline ET day key", moved.every((f) => !/toLocaleDateString\("en-CA", \{ timeZone: "America\/New_York" \}\)/.test(src(f))), moved.filter((f) => /toLocaleDateString\("en-CA"/.test(src(f))).join(", "));
    c.ok("ProgramRolloutPanel's 30-day default uses etDayKey; its stored end day keeps the tolerant copy", /in30Days = \(\) => etDayKey\(/.test(src("src/components/settings/ProgramRolloutPanel.tsx")) && /endDayInput[^\n]*toLocaleDateString\("en-CA"/.test(src("src/components/settings/ProgramRolloutPanel.tsx")));
    c.ok("lib/datetime stays client-safe (no imports, no server-only)", !/^\s*import\s/m.test(src("src/lib/datetime.ts")) && !/server-only/.test(src("src/lib/datetime.ts")));

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
