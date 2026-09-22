import type { AutomationKey } from "@/lib/programAutomation";

// ---------------------------------------------------------------------------
// The WORDS for the automation switches (spec §13). A plain module, not a
// "use server" one, because both the owner-facing panel (a client component
// that quotes the effect in its confirm) and the server action (which writes
// the same sentence into the audit note) need the same text — and a
// "use server" file may only export async functions.
//
// THERE IS NO REMINDER POLICY HERE. There was, briefly, and it was a second
// incompatible shape for the same `reminders` config the reminder evaluator
// reads: a policy saved by one editor could not be read by the other, so the
// switch could never be turned on once a real policy existed, and the editor
// here silently overwrote the rules that decide when a client gets emailed.
// The policy has ONE definition — REMINDER_DEFAULTS / validateReminderPolicy
// in src/lib/programReminders.ts — and ONE editor, Settings → Program
// reminders. Jordan's 4:30 pm ET / weekdays-only rule is expressed there, in
// businessHours, and does not need a second encoding.
// ---------------------------------------------------------------------------

/** What turning this on actually starts doing. Written to be read out loud before saying yes. */
export const AUTOMATION_EFFECTS: Record<AutomationKey, { title: string; onEffect: string; reaches: "clients" | "staff" | "internal"; blocked?: string }> = {
  reminders: {
    title: "Client reminders",
    onEffect: "The hub starts EMAILING CLIENTS on its own — reminders to choose a planning path, book a call, finish their answers, book a session and review work — inside the hours the reminder policy sets (Settings → Program reminders, where you can also dry-run exactly what would go out). Nothing else in the hub sends a client an email without a person pressing send.",
    reaches: "clients",
  },
  transcript_jobs: {
    title: "Transcript processing",
    onEffect: "Queued call transcripts are analysed automatically into topics, answers, facts and script inputs, spending AI credit per run. Results still land as proposals a person reviews.",
    reaches: "internal",
  },
  script_drafting: {
    title: "Draft the scripts a month owes",
    onEffect: "Once a month's topics are settled, the hub drafts each script on its own — from the client's written answers where they gave them, otherwise from the planning call's excerpts. It never drafts a topic with neither (that one waits for a person), never drafts a topic still only proposed by the call, and nothing it writes is approved, released or client-visible. Spends AI credit per script.",
    reaches: "internal",
  },
  ai_runs: {
    title: "AI runs (master switch)",
    onEffect: "Allows every kind of generation to execute at all. With this off, no strategy, topic bank, script or caption can be generated, however its own switch is set.",
    reaches: "internal",
  },
  publishing: {
    title: "Instagram publishing",
    onEffect: "Approved videos would be posted to a connected Instagram account.",
    reaches: "clients",
    blocked: "No credentials exist: this needs a Meta app, an Instagram Business account and app review. Turning it on today does nothing but record your intent.",
  },
  script_share_email: {
    title: "Approve & share → email the client",
    onEffect: "Approving a script version EMAILS IT TO THE CLIENT immediately instead of only releasing it to their portal.",
    reaches: "clients",
  },
  portal_invites: {
    title: "Portal invitations",
    onEffect: "Real clients can be invited to the portal by email. Until this is on, invitations only go to staff-controlled test addresses.",
    reaches: "clients",
  },
  portal_login_email: {
    title: "Portal sign-in links",
    onEffect: "A client who asks to sign in is emailed a magic link. Transactional — it answers a request the person just made, and is not held for quiet hours.",
    reaches: "clients",
  },
  topic_refresh: {
    title: "One-click topic refresh",
    onEffect: "The Video Topics refresh button can call the model. Suggestions never overwrite a selected, approved or in-production topic.",
    reaches: "internal",
  },
  strategy_generation: {
    title: "Strategy drafting",
    onEffect: "A discovery call can be drafted into a strategy version automatically. The draft still needs Jordan's approval before anyone sees it.",
    reaches: "internal",
  },
  session_booking: {
    title: "Self-booking against Aryeo",
    onEffect: "A client's session request would create a real Aryeo appointment rather than a request Kyle confirms by hand.",
    reaches: "clients",
  },
  cut_transcripts: {
    title: "Transcribing delivered cuts",
    onEffect: "Delivered videos would be transcribed for captions and search.",
    reaches: "internal",
    blocked: "No speech-to-text provider is configured (this needs an OpenAI Whisper or Deepgram key). Turning it on today does nothing.",
  },
  caption_assistant: {
    title: "Caption assistant",
    onEffect: "Captions are drafted from the script and strategy for each delivered video, with gaps shown rather than invented.",
    reaches: "internal",
  },
  fact_extraction: {
    title: "Automatic fact acceptance",
    onEffect: "Facts extracted from calls on the documented low-risk fields are ACCEPTED without a person reading them, which means they reach generators and the editor brief on their own.",
    reaches: "internal",
  },
};
