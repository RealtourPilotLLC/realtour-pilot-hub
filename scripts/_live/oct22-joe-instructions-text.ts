// Live one-off (Oct 22 2026, Jordan: "Make sure to message the photographers
// on Joe's instructions"). Texts Harrison and James (both on Joe Sutow's
// shoots) about the new "Instructions added to Dropbox" option. --apply sends.
import { prisma } from "@/lib/prisma";
import { queueStaffSms } from "@/lib/notify";
const HARRISON = "cmqiiczur00059k2mzj3vtn5k";
const JAMES = "cmqiiczmn00029k2mfmvdkvff";
const base = "https://hub.realtourpilot.com/upload/";
const line = (name: string) =>
  `Hi ${name}, Joe Sutow's 859 N Lawrence St and 538 Onward Ave still need the edit instructions before editing can start. If you put them in Dropbox, open each job's upload page, tap "Instructions added to Dropbox" and pick the file so the editor sees it. The wrap-up, cull and removal notes are still needed on the page too. 859 N Lawrence: ${base}cmv7g70jf0005jp0630bolmjp 538 Onward: ${base}cmv8imvz10007l40697tgc80c`;
(async () => {
  for (const [id, name] of [[HARRISON, "Harrison"], [JAMES, "James"]] as const) {
    console.log(name, "→", line(name));
    if (process.argv.includes("--apply")) console.log("queued:", await queueStaffSms(id, line(name), { kind: "staff_sms" }));
  }
  await prisma.$disconnect();
})();
