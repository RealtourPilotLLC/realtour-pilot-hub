// ---------------------------------------------------------------------------
// LIVE DRY RUN (Oct 23 2026): THE PHOTOGRAPHER BRIEF, AS EACH PHOTOGRAPHER
// WOULD GET IT. Read-only, always: the database connection is opened with
// default_transaction_read_only, nothing is written (not even the first-seen
// registry the cron keeps) and nothing is sent.
//
// Jordan wants to see a sample before the `photographer_brief` switch goes on
// (Settings, Internal alerts, Photographer brief). This prints, from the live
// appointments, the exact text each photographer would get for the next
// business day, plus any weekend day the same run covers (Friday's run covers
// Saturday, Sunday and Monday), what the full-brief page adds (the earlier
// visit's notes, folded), and anyone who could not be texted.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct23-brief-preview.ts
//   … scripts/_live/oct23-brief-preview.ts 2026-10-23     (any one ET day instead)
//
// (the preload stubs next/navigation, which lib/clientAsks reaches through
// lib/auth/user; it leaves scripts/_live connected to the real database)
// ---------------------------------------------------------------------------
export {};

{
  // A dry run cannot write, whatever the code below does.
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}
// Links as the deployed hub writes them.
if (!process.env.NEXT_PUBLIC_APP_URL && !process.env.APP_URL) process.env.APP_URL = "https://hub.realtourpilot.com";

async function main() {
  const { etDayKey, etTime, etDateTime } = await import("@/lib/datetime");
  const core = await import("@/lib/photographerBriefCore");
  const brief = await import("@/lib/photographerBrief");
  const { appBase } = await import("@/lib/appUrl");
  const { staffTextNumber } = await import("@/lib/hubSms");
  const { prisma } = await import("@/lib/prisma");

  const now = new Date();
  const asked = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const today = etDayKey(now);
  const target = asked ?? core.nextBusinessDayKey(today);
  const runDay = core.prevBusinessDayKey(target);
  const days = asked ? [asked] : core.daysCoveredBy(runDay);
  const settings = await brief.photographerBriefSettings();
  const due = core.briefDueAt(target, settings);

  console.log("THE PHOTOGRAPHER BRIEF, DRY RUN (read-only, nothing sent)");
  console.log(`Now: ${etDateTime(now)} ET`);
  console.log(`Switch photographer_brief: ${settings.enabled ? "ON" : "OFF (nothing sends; statuses read off)"}; send time ${core.sendTimeWords(settings.sendMinute)} ET the business day before`);
  console.log(`${asked ? "Day asked for" : "Next business day"}: ${core.dayWords(target)}. Its brief goes ${core.dayWords(runDay)} at ${etTime(due)} ET.`);
  if (!asked) console.log(`That run covers: ${days.map(core.dayWords).join(", ")}`);

  const build = await brief.buildBriefDays(days, { now });
  if (!build.briefs.length) console.log("\nNo live shoots with a photographer on those days.");
  for (const b of build.briefs) {
    const link = `${appBase()}/shoot/brief/${b.day}`;
    const num = staffTextNumber(b.phone);
    console.log(`\n================ ${b.name}, ${core.dayWords(b.day)} (${b.shoots.length} shoot${b.shoots.length === 1 ? "" : "s"}) ================`);
    console.log(`To: ${num ? `phone ending ${num.key.slice(-4)}` : "NO TEXTABLE PHONE ON FILE (would read failed)"}${b.active ? "" : " (NOT AN ACTIVE TEAM MEMBER)"}`);
    console.log("--- the text ---");
    console.log(core.composeBriefText(b, link));
    console.log("--- end of text ---");
    for (const s of b.shoots) {
      if (s.earlier.length) {
        console.log(`Page only, folded under "earlier visit" for ${s.street}:`);
        for (const e of s.earlier) console.log(`  · ${e}`);
      }
    }
    const statuses = await brief.briefStatusForAppointments(b.shoots.map((s) => s.appointmentId));
    const st = statuses.get(b.shoots[0]?.appointmentId ?? "");
    if (st) console.log(`Status now: ${st.state}${st.why ? ` (${st.why})` : ""}`);
    console.log(`Digest: ${b.digest}`);
  }
  for (const u of build.unassigned) console.log(`\nNo photographer on ${u.street} (${core.dayWords(u.day)}): nobody would get a brief for it.`);
  const dashes = build.briefs.map((b) => core.composeBriefText(b, `${appBase()}/shoot/brief/${b.day}`)).filter((t) => /[–—]/.test(t));
  console.log(`\n${build.briefs.length} brief(s); em or en dashes in any text: ${dashes.length ? "YES" : "none"}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
