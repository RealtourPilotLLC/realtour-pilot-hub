// Oct 12 2026 (Jordan): "All the automations should be on — I just don't want
// notifications going out to the clients yet." Same write as Settings →
// Automations (programAutomation.setAutomation). Client-NOTIFYING switches stay
// off (reminders, script_share_email, portal_invites, portal_login_email,
// program_message_notice), as do publishing (public Instagram posts) and
// legacy_call_sweeps (superseded first-name matching). Client-reaching portal/
// booking switches only reach clients the rollout names (TEST today; per client
// from Settings → Client onboarding).
import { prisma } from "../../../src/lib/prisma";
const ON = ["ai_runs", "transcript_jobs", "script_drafting", "topic_refresh", "strategy_generation", "cut_transcripts", "fact_extraction", "brand_change_alerts", "topic_carryover", "caption_assistant", "revision_policy", "review_auto_approve", "script_auto_share", "session_booking", "address_sync", "call_booking"] as const;
(async () => {
  const { setAutomation, isAutomationEnabled } = await import("../../../src/lib/programAutomation");
  for (const k of ON) { await setAutomation(k as any, true, "info@realtourpilot.com", null); }
  const { AUTOMATION_EFFECTS } = await import("../../../src/lib/programAutomationCopy");
  for (const k of Object.keys(AUTOMATION_EFFECTS)) console.log(k.padEnd(22), (await isAutomationEnabled(k as any)) ? "ON " : "off", (AUTOMATION_EFFECTS as any)[k].reaches);
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
