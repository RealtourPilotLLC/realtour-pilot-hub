// ACCEPTANCE 4, RE-STATED AGAINST THE REAL SUBMIT PATHS (reviewer, Sep 18).
//
// scripts/_agent/A-units/scope-rule.ts case 5 — "a single-video job still
// closes on approval" — hands outstandingItems a hand-written slot key
// (`approvedKeys: new Set(["del_video:1"])`). The editor's OTHER door never
// produces that key: syncFinalCutsToReview (the "Done — send to review"
// button, and the hourly folder sweep) creates the ReviewSubmission with NO
// deliverableId — see src/lib/reviewCuts.ts, the create() inside
// syncFinalCutsToReview — so cutKeyOf keys the round by its Dropbox path. 14 of
// the 35 rounds in production are that shape. The fixture therefore passed on a
// key the failing path cannot mint, and the case it claimed to cover failed.
//
// This runs the rule through the SHIPPED key builder (reviewCuts.approvedSlotKeys
// → owedSlotKeyOf), with round shapes taken from both real doors, so nothing
// here is hand-keyed. Pure: no database, no writes.
import { approvedSlotKeys, owedSlotKeyOf } from "@/lib/reviewCuts";
import { outstandingItems, type ScopedItem } from "@/lib/revisionBrief";

const DEL = "cmsnr2ycm000vjr0411ci8om2"; // 1956 Wetherhill Dr's video row
const SLOT1 = `${DEL}:1`;

// The two doors, as rows:
//  · UPLOAD — startCutUpload picks the slot, so the row carries it.
const uploaded = (status: string, slot = 1) => ({ deliverableId: DEL, slot, assetPath: null, id: `up${slot}`, status });
//  · FOLDER — syncFinalCutsToReview knows only the file it found.
const folder = (status: string, name: string) => ({ deliverableId: null, slot: 1, assetPath: `/AutoHDR/…/05-Final-Video/${name}`, id: `fo-${name}`, status });

const ONE_ASK: ScopedItem[] = [{ id: "i1", ask: "Trim the ending", cuts: null, scope: "all" }];

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n        got: ${JSON.stringify(got)}   expected: ${JSON.stringify(want)}`);
};

// ---- 1. THE KEY BUILDER ITSELF ------------------------------------------
check("an uploaded round keys to its slot", owedSlotKeyOf(uploaded("APPROVED"), [SLOT1]), SLOT1);
check("a folder round on a ONE-slot job keys to that slot", owedSlotKeyOf(folder("APPROVED", "Finish_1956.mp4"), [SLOT1]), SLOT1);
check(
  "a folder round on a FOUR-slot job keys to nothing — it is not guessed",
  owedSlotKeyOf(folder("APPROVED", "Finish_1956.mp4"), [`${DEL}:1`, `${DEL}:2`, `${DEL}:3`, `${DEL}:4`]),
  null,
);
check("a round that is not approved contributes no key", [...approvedSlotKeys([folder("PENDING", "v1.mov")], [SLOT1])], []);

// ---- 2. ACCEPTANCE 4, CASE 5, ON THE FOLDER PATH -------------------------
// This is the case the old fixture claimed and did not test. Both of 1956
// Wetherhill Dr's approved rounds are folder rows.
const folderApprovals = approvedSlotKeys(
  [folder("APPROVED", "Finish_1956 Wetherhill Dr_1_prob4.mp4"), folder("APPROVED", "Revised_1956 Wetherhill Dr_1_prob4.mp4")],
  [SLOT1],
);
check("the folder path's approvals land in the SLOT key space", [...folderApprovals], [SLOT1]);
check(
  "a single-video job closes on approval — EDITOR'S FOLDER SUBMIT",
  outstandingItems({ items: ONE_ASK, done: [], approvedKeys: folderApprovals, owedKeys: [SLOT1] }).map((i) => i.id),
  [],
);
check(
  "a single-video job closes on approval — EDITOR'S UPLOAD PANEL",
  outstandingItems({ items: ONE_ASK, done: [], approvedKeys: approvedSlotKeys([uploaded("APPROVED")], [SLOT1]), owedKeys: [SLOT1] }).map((i) => i.id),
  [],
);

// ---- 3. THE OLD BEHAVIOUR, SO THE REGRESSION CANNOT COME BACK QUIETLY ----
// cutKeyOf's answer for a folder round, fed to the rule the way the shipped
// code used to feed it.
const cutKeyed = new Set(["/AutoHDR/…/05-Final-Video/Finish_1956 Wetherhill Dr_1_prob4.mp4"]);
check(
  "the OLD key space leaves the ask open on a job with nothing left to do",
  outstandingItems({ items: ONE_ASK, done: [], approvedKeys: cutKeyed, owedKeys: [SLOT1] }).map((i) => i.id),
  ["i1"],
);

// ---- 4. AND IT STILL DOES NOT CLOSE SOMEBODY ELSE'S VIDEO ----------------
// Jordan's rule (Sep 18): "Fixing video 1 must not close an untouched request
// for video 3." Re-checked in the new key space, with real upload rows.
const fourOwed = [`${DEL}:1`, `${DEL}:2`, `${DEL}:3`, `${DEL}:4`];
const items: ScopedItem[] = [
  { id: "i1", ask: "Swap the music on video 1", cuts: [`${DEL}:1`], scope: "named" },
  { id: "i2", ask: "Fix the street spelling on video 3", cuts: [`${DEL}:3`], scope: "named" },
  { id: "i3", ask: "Make them all punchier", cuts: null, scope: "all" },
];
check(
  "approving video 1 leaves video 3's item open",
  outstandingItems({ items, done: [], approvedKeys: approvedSlotKeys([uploaded("APPROVED", 1)], fourOwed), owedKeys: fourOwed }).map((i) => i.id),
  ["i2", "i3"],
);
check(
  "a FOLDER approval on a four-video job closes nothing it cannot name",
  outstandingItems({ items, done: [], approvedKeys: approvedSlotKeys([folder("APPROVED", "one of them.mov")], fourOwed), owedKeys: fourOwed }).map((i) => i.id),
  ["i1", "i2", "i3"],
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
