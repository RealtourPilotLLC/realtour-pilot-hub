// Read-only: what Aryeo offers for a 4-hour session with Jordan (and others) around Oct 29.
import { AryeoBooking } from "@/lib/integrations/aryeo";
(async () => {
  const J = "3352bfaf-a2a9-4cfc-9395-df12ea3c0737";
  for (const date of ["2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03"]) {
    const s = await AryeoBooking.timeslotsFor({ date, durationMin: 240, teamMemberIds: [J] }).catch((e) => String(e).slice(0, 160));
    console.log(date, typeof s === "string" ? s : s.map((x) => new Date(x.startAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })).join(" ") || "(none)");
  }
})();
