// Oct 13 2026 (Jordan): "Open the raw footage" didn't work — a job's
// 02-RAW-Video had been renamed outside the hub. The matcher that finds the
// renamed standard folder (the folder engine renames it back; the Open link
// goes to it). Pure — no database, no Dropbox.
import { strayStandardFolder } from "../../src/lib/dropboxFolders";

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const t = (names: string[]) => strayStandardFolder(names, "02-RAW-Video");

console.log("\n=== Oct 13: renamed standard Dropbox folders ===\n");
ok("'<job>_02-RAW-Video' (2625 Wassergass Rd) is the renamed folder", t(["01-RAW-Photos", "2625 Wassergass Rd (Georgiana Torrella)_02-RAW-Video"]) === "2625 Wassergass Rd (Georgiana Torrella)_02-RAW-Video");
ok("'1_<job>_02-RAW-Video' (3826 Fairmount Ave) too", t(["1_3826 Fairmount Ave (Stephen Kennedy)_02-RAW-Video"]) === "1_3826 Fairmount Ave (Stephen Kennedy)_02-RAW-Video");
ok("'02-RAW-Video (1)' beside the standard one (2549 Crestline Dr) is found", t(["02-RAW-Video", "02-RAW-Video (1)"]) === "02-RAW-Video (1)");
ok("a folder that only looks similar is never taken", t(["02-RAW-Video-old", "B-roll", "Music"]) === null);
ok("two candidates are for a person, not the hub", t(["a_02-RAW-Video", "b_02-RAW-Video"]) === null);
ok("the standard folder alone is not a stray", t(["02-RAW-Video", "05-Final-Video"]) === null);
ok("works for the other standard folders", strayStandardFolder(["x_04-Final-Photos"], "04-Final-Photos") === "x_04-Final-Photos");

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
