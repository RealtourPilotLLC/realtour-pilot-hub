// ACCEPTANCE 4 (audit WF-03): "A revision naming video 1 does not close an item
// scoped to video 3." Exercises the PURE rule — no database, no writes, so the
// case can be re-run at any time and reads as a fixture rather than a story
// about production rows.
import { outstandingItems, outstandingReason, type RevisionItem } from "@/lib/revisionBrief";

const V = (n: number) => `del_video:${n}`;
const owedKeys = [V(1), V(2), V(3), V(4)];

const items: RevisionItem[] = [
  { id: "i1", area: "Music & sound", ask: "Swap the music on the kitchen video", cuts: [V(1)], scope: "named" },
  { id: "i2", area: "On-screen text", ask: "Fix the spelling of the street on video 3", cuts: [V(3)], scope: "named" },
  { id: "i3", area: "Overall direction", ask: "Make them all punchier", cuts: null, scope: "all" },
  { id: "i4", area: "Other", ask: "The intro felt slow", cuts: null, scope: undefined }, // a pre-scope row
];

let failures = 0;
const check = (name: string, got: string[], want: string[]) => {
  const ok = got.length === want.length && got.every((g, i) => g === want[i]);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        still open: [${got.join(", ")}]  expected: [${want.join(", ")}]`);
};

// 1. Video 1 approved. The item about video 3 must survive, and so must the
//    two that cover every video.
check(
  "approving video 1 leaves video 3's item open",
  outstandingItems({ items, done: [], approvedKeys: new Set([V(1)]), owedKeys }).map((i) => i.id),
  ["i2", "i3", "i4"],
);

// 2. Video 3 approved as well: its item closes, the job-wide ones do not.
check(
  "approving 1 and 3 closes both named items only",
  outstandingItems({ items, done: [], approvedKeys: new Set([V(1), V(3)]), owedKeys }).map((i) => i.id),
  ["i3", "i4"],
);

// 3. Every video back through the Room: nothing is left untouched, so the
//    job-wide asks (and the unplaced one) are answered too.
check(
  "every video approved closes the whole ask",
  outstandingItems({ items, done: [], approvedKeys: new Set(owedKeys), owedKeys }).map((i) => i.id),
  [],
);

// 4. A person ticking an item is that person's word about that item.
check(
  "a ticked item is done whoever approved what",
  outstandingItems({ items, done: ["i2", "i3", "i4"], approvedKeys: new Set([V(1)]), owedKeys }).map((i) => i.id),
  [],
);

// 5. The old failure mode, stated as its own case: one video, one ask, one
//    approval — the revision must still close on its own.
check(
  "a single-video job still closes on approval",
  outstandingItems({
    items: [{ id: "i1", area: "Other", ask: "Trim the ending", cuts: [V(1)], scope: "all" }],
    done: [],
    approvedKeys: new Set([V(1)]),
    owedKeys: [V(1)],
  }).map((i) => i.id),
  [],
);

// 6. An item naming a video that has since left the order cannot hold the ask
//    open for ever.
check(
  "an item on a removed video does not hold the ask",
  outstandingItems({
    items: [{ id: "i1", area: "Other", ask: "Fix the removed one", cuts: ["del_gone:1"], scope: "named" }],
    done: [],
    approvedKeys: new Set([V(1)]),
    owedKeys,
  }).map((i) => i.id),
  [],
);

// 7. A job that owes no video any more cannot be holding an unfinished change.
check(
  "a job with nothing owed does not hold the ask open",
  outstandingItems({ items, done: [], approvedKeys: new Set([V(1)]), owedKeys: [] }).map((i) => i.id),
  [],
);

const open = outstandingItems({ items, done: [], approvedKeys: new Set([V(1)]), owedKeys });
console.log(`\nthe line the timeline would print:\n  "${outstandingReason(open, items.length)}"`);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
