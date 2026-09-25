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
    title: "Prepare and draft what a month owes",
    onEffect: "Two steps of one chain. First, for each topic the month has committed to, the hub phrases the six planning questions FOR THAT TOPIC before the client opens them — so they read a question about their actual subject instead of the house wording. Then it drafts each owed script: from the client's written answers where they gave them, otherwise from the planning call's excerpts. It never drafts a topic with neither (that one waits for a person), never touches a topic still only proposed by the call, and nothing it writes is approved, released or client-visible. Spends AI credit per question set and per script.",
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
    // CP-07: this used to say it gated the refresh button, which was never true —
    // the button is a person's click and runs whatever this is set to.
    title: "Automatic topic bank",
    onEffect: "The hub builds each client's first topic bank on its own once their strategy is approved, and tops a pillar back up when its usable topics fall below the target (once a week at most per pillar; suggestions you have not reviewed count as stock, so an unreviewed pile stops new spend). Everything it writes is a SUGGESTION on Video Topics: no client sees an AI topic until you accept it. Spends AI credit per run (the AI runs master switch must also be on). The Refresh topics button works either way.",
    reaches: "internal",
  },
  topic_carryover: {
    title: "Carry unfilmed scripts into the new month",
    onEffect: "On the 1st, every scripted topic that was not filmed last month moves into the new month and takes one of its videos, with its script and every version kept. The client sees it under \"Scripted, not filmed\" and can swap it for another topic, which frees the slot. Check the list first with \"Check carry-over\" on the client's Video Topics tab. Nothing is sent to the client; they see it on their portal.",
    // "clients", not "internal": nothing is sent, but the carried topic is on
    // their page and occupies their allowance, which is a client-facing fact.
    reaches: "clients",
  },
  strategy_generation: {
    title: "Strategy drafting",
    onEffect: "A discovery call can be drafted into a strategy version automatically. The draft still needs Jordan's approval before anyone sees it.",
    reaches: "internal",
  },
  session_booking: {
    title: "Self-booking against Aryeo",
    onEffect: "A client's session request CREATES A REAL ARYEO ORDER AND APPOINTMENT (one order per session, on the creative they picked), reads it back and shows it as booked, instead of a request Kyle books by hand. It also lets the hub cancel or move a session it booked itself. ONLY for clients listed in this switch's authorizedFixtureClientIds (TEST fixtures only); everyone else stays desk-assisted. Aryeo's customer notifications stay off; our team gets Aryeo's own notice.",
    reaches: "clients",
  },
  address_sync: {
    title: "Exact-address sync to Aryeo",
    onEffect: "When a client adds the exact filming address for a session, the hub UPDATES THAT SESSION'S ADDRESS IN ARYEO itself and reads it back, instead of leaving it on Kyle's desk. ONLY for clients listed in authorizedFixtureClientIds (TEST fixtures only). Two sessions sharing one Aryeo address are never changed by the hub; Kyle gets them.",
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
  revision_policy: {
    title: "Review deadlines and revision rounds",
    onEffect: "CLIENTS SEE a review deadline (four business days, Mon to Fri) and how many of their two included revision rounds each video has used. A third round asks the account owner to acknowledge that an extra round may carry a $50 fee; the office then charges or waives it, and nothing is ever charged automatically. A change request after the deadline is refused and Kyle is asked to reopen it, and an expired review becomes a task for Kyle. Only reviews opened after you turn this on are held to a deadline.",
    reaches: "clients",
  },
  review_auto_approve: {
    title: "Automatic approval on expiry",
    onEffect: "When a review deadline passes with no answer, no open notes and no other hold, the hub records the approval itself (\"Automatic approval\") instead of handing it to Kyle. Needs Review deadlines on too, applies only to reviews opened after you turn this on, and by default only to TEST clients (testClientsOnly).",
    reaches: "clients",
  },
  brand_change_alerts: {
    title: "Brand-change alerts to the editor",
    onEffect: "When a client changes their brand profile or uploads a brand file (or a person applies a change from a call), the editor on their work gets a bell and a Slack DM naming what changed — at most one DM per client per hour. With this off the change is still recorded, still shows as a banner on the editor's brief and still gives Kyle a task to confirm the editor has it; only the message to the editor waits. Changes made while it was off and not yet acknowledged (up to seven days old) are sent within the hour once you turn it on.",
    reaches: "staff",
  },
  topic_folders: {
    title: "Topic folders in Dropbox",
    onEffect: "Every content session gets ONE FOLDER PER TOPIC inside the job's 02-RAW-Video folder in the company Dropbox, named like \"01 Pricing in week one [a1b2c3d4]\" — the bracket is the topic's permanent id, so a topic renamed later keeps its folder and its clips. Made the hour before a session and again when the photographer submits (an extra topic filmed on site gets one too). The hub never renames, moves or deletes one: a folder somebody renamed by hand is found by its bracket (or its Dropbox id) and kept. The upload page and the editor's brief link each topic to its folder. Check one TEST job's folder names before turning this on, then tell the photographers to file clips per topic.",
    reaches: "internal",
  },
  program_message_notice: {
    title: "Email clients when the office replies",
    onEffect: "When someone on the team replies on a client's Messages tab, each person on that account (owner and assistant seats, not view-only) gets ONE email saying who replied, with the reply and the sign-in link, unless they already read it on the portal. A second reply before they read the first does not send another. Sent only Mon to Fri before 4:30pm ET; a reply written later goes out the next working morning. Replies from the last three days that nobody has read yet are sent within the hour of turning this on. With this off, replies still appear on the client's page; only the email waits.",
    reaches: "clients",
  },
  portal_layout_v2: {
    title: "New portal layout for every client",
    onEffect: "EVERY CLIENT'S PORTAL switches to the new layout on their next page load: Home with one next step, My Plan (this month, scripts to approve, topic bank, strategy), Content Library (videos to review first, search and filters), Schedule, and More (Brand Profile, Messages, Resources, Settings & Team, Terms), with a bottom bar on phones. Nothing is sent and no data changes; old links keep working. TEST clients already see it, and staff can preview any client with ?layout=v2. Turning it off puts everyone back on today's layout.",
    reaches: "clients",
  },
};
