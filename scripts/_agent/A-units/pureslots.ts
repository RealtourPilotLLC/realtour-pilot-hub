// READ-ONLY. The OTHER slot builder: reviewCuts.pureSlots, which feeds
// videoStatesFor (Ops Day, the home Video Review card, the project rows). It
// took the same waived fix, so it has to agree with the same baseline file —
// otherwise one screen would count a video the Review Room does not.
import { readFileSync } from "fs";
import { videoStatesFor } from "@/lib/reviewCuts";

type Baseline = { keys: Record<string, string[]> };

async function main() {
  const base: Baseline = JSON.parse(readFileSync("scripts/_agent/A-units/slot-baseline.json", "utf8"));
  const ids = Object.keys(base.keys);
  let checked = 0, mismatch = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const states = await videoStatesFor(chunk);
    for (const id of chunk) {
      const want = base.keys[id].length;
      const got = states.get(id)?.owed ?? 0;
      checked++;
      if (got !== want) { mismatch++; console.log(`  MISMATCH ${id}: baseline ${want} owed, videoStatesFor ${got}`); }
    }
  }
  console.log(`\nprojects checked: ${checked} · owed-count mismatches vs the pre-change baseline: ${mismatch}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
