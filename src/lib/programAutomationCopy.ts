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

// ---------------------------------------------------------------------------
// WHAT EACH SWITCH NEEDS BEFORE IT CAN DO ANYTHING (A56, unified handoff §11,
// Sep 28 2026). "Do not make a switch look effective when another gate
// prevents its operation." A switch can read ON while AI runs is off, while the
// provider it writes to is not connected, or while its own config would not
// run, and the settings screen used to show that as a plain green "on". These
// fields are what lib/readiness.ts judges against, and they are words here,
// beside the effect sentence, so the two cannot drift apart:
//
//   requires.switches   other switches that must ALSO be on
//   requires.providers  connections that must be connected (Settings shows
//                       them; /connections is where they are fixed)
//   requires.config     the switch's own stored config must pass a check
//   requires.partial    a switch that stops PART of this one (a named path),
//                       never all of it — readiness reports it as a blocker
//                       for that path and never calls the switch healthy
//   recipients          who actually hears about it, in plain words
//   cadence             how often its driver runs, which is what "late" means
//   launchGate          who a client-reaching switch may touch: programScope
//                       (the rollout scope, lib/programRolloutCore) or
//                       hubWriteScope (TEST fixtures + the program pilot)
//
// Presentation and judgement only. Nothing here turns anything on.
//
// WHO, NOT WHETHER (R03, Sep 28 2026). Every client-reaching program switch is
// now read with the rollout scope — Settings → "Who the program may reach":
// TEST clients only, TEST clients plus a named pilot of at most three, or
// every client with a program. The switch stays the on/off; the scope decides
// who. So none of the sentences below may promise "every client": the switch
// on means "the clients the rollout reaches", and only the rollout set to
// everyone makes that every client. A feature's own testClientsOnly lock is
// still there, but only NARROWS inside the scope (lifting it lets the scope
// in, never everyone).
//
// THE CALL PROCESSOR IS A DEPENDENCY (R05, Sep 28 2026). strategy_generation's
// only automatic path is the transcript queue (programOnboarding enqueues a
// STRATEGY_DRAFT; transcriptJobs runs it), so it needs transcript_jobs as
// well as ai_runs; readiness called it effective and healthy while its drafts
// sat unprocessed. script_drafting and fact_extraction depend on the processor
// for one path each (requires.partial).
// ---------------------------------------------------------------------------

/** A connection a switch depends on. Mapped to Connection rows in lib/readiness.ts. */
export type ReadinessProvider = "ai" | "aryeo" | "gmail" | "slack" | "dropbox" | "openphone" | "calendly" | "stt" | "instagram" | "topaz";
/** A check on the switch's own stored config. */
export type ReadinessConfigCheck =
  | "fixtures" // session_booking / address_sync / call_booking: somebody is in scope (a TEST fixture or an approved pilot), and every fixture is a real fixture
  | "reminderPolicy" // the stored reminder policy passes the evaluator's own validator
  | "callApiMode" // call_booking config.mode is "API" (EMBED means the portal embeds Calendly and the hub books nothing)
  | "noCallMapping"; // legacy sweeps stand down while any Calendly mapping is enabled
export type AutomationCadence = "hourly" | "daily" | "on-action";
/**
 * Who a client-reaching switch may touch (R03, Sep 28 2026).
 *   programScope   the rollout scope (lib/programRolloutCore.rolloutDecision),
 *                  narrowed by the feature's own testClientsOnly lock where it
 *                  has one (programRollout.featureTestOnlyFor). The twelve
 *                  client-reaching program switches (caption_assistant joined
 *                  them in the Sep 28 review fix).
 *   hubWriteScope  the provider writes: TEST fixtures on the switch, plus the
 *                  PROGRAM pilot when its "bookings" group is ticked (Jordan's
 *                  Sep 28 rule: one pilot list, programRolloutCore.withProgramPilot).
 * The old "reminderPolicy" and "testClientsOnly" gates meant "TEST clients, or
 * every real client once the lock is lifted"; they are gone, because lifting a
 * lock no longer means every real client.
 */
export type LaunchGate = "programScope" | "hubWriteScope";

/**
 * What the owner types to let the program reach EVERY client with a program
 * (Settings → Who the program may reach; business default 4, Sep 28 2026).
 * Here, not in the action file, because a "use server" file may export only
 * async functions and the panel quotes the same words.
 */
export const EVERY_CLIENT_CONFIRM = "EVERY CLIENT";

/** A switch that stops one named path of another, never all of it. */
export type PartialDependency = { switch: AutomationKey; why: string };

export type AutomationEffect = {
  title: string;
  onEffect: string;
  reaches: "clients" | "staff" | "internal";
  blocked?: string;
  requires?: { switches?: AutomationKey[]; providers?: ReadinessProvider[]; config?: ReadinessConfigCheck[]; partial?: PartialDependency[] };
  recipients: string;
  cadence: AutomationCadence;
  launchGate?: LaunchGate;
};

/** What turning this on actually starts doing. Written to be read out loud before saying yes. */
export const AUTOMATION_EFFECTS: Record<AutomationKey, AutomationEffect> = {
  reminders: {
    title: "Client reminders",
    onEffect: "The hub starts EMAILING THE CLIENTS THE ROLLOUT REACHES on its own (Who the program may reach, below: your TEST clients, and any pilot clients you named) — reminders to choose a planning path, book a call, finish their answers, book a session, give the exact filming address, approve scripts and review work — inside the hours the reminder policy sets (Settings → Program reminders, where you can also dry-run exactly what would go out and to whom). The policy's testClientsOnly lock narrows it further to TEST clients until you lift it. Nothing else in the hub sends a client an email without a person pressing send.",
    reaches: "clients",
    requires: { providers: ["gmail"], config: ["reminderPolicy"] },
    // ONE address per client, not each seat (R05 copy fix, Sep 28 2026):
    // programReminders.recipientFor picks the first OWNER seat, else the
    // client's own email.
    recipients: "One address per client: the first owner seat on the program, else the client's email. By email, from info@",
    cadence: "hourly",
    launchGate: "programScope",
  },
  transcript_jobs: {
    title: "Transcript processing",
    onEffect: "The call processor: queued call transcripts are pulled in and analysed automatically into topics, answers, facts and script inputs, and queued strategy drafts are written, spending AI credit per run (AI runs must also be on). By default it only takes jobs queued AFTER you first turn it on: anything already waiting is skipped unless you choose to include it (Settings → Calendly & calls, which shows the count). Until the rollout is set to everyone, AI work runs only for your TEST clients and the pilot clients you named. Five jobs per hourly run. Results still land as proposals a person reviews; nothing is released to a client. The Draft strategy now, Draft owed scripts and Re-analyse buttons run straight away and do not use this queue.",
    reaches: "internal",
    requires: { switches: ["ai_runs"], providers: ["ai"] },
    recipients: "Nobody is messaged. Results wait as proposals on the client file, drafts in Jordan's queue",
    cadence: "hourly",
  },
  script_drafting: {
    title: "Prepare and draft what a month owes",
    onEffect: "Two steps of one chain. First, for each topic the month has committed to, the hub phrases the six planning questions FOR THAT TOPIC before the client opens them — so they read a question about their actual subject instead of the house wording. Then it drafts each owed script: from the client's written answers where they gave them, otherwise from the planning call's excerpts. It never drafts a topic with neither (that one waits for a person), never touches a topic still only proposed by the call, and nothing it writes is approved, released or client-visible. Spends AI credit per question set and per script.",
    reaches: "internal",
    requires: {
      switches: ["ai_runs"],
      providers: ["ai"],
      // contentDrafting.ts: a FROM_CALL topic is drafted from the call's
      // excerpts, which only the call processor's ANALYZE writes.
      partial: [{ switch: "transcript_jobs", why: "scripts drafted from a planning call need the call's analysis; the written-answers path does not" }],
    },
    recipients: "Nobody is messaged. Drafts wait in Jordan's script review queue",
    cadence: "hourly",
  },
  ai_runs: {
    title: "AI runs (master switch)",
    onEffect: "Allows every kind of generation to execute at all. With this off, no strategy, topic bank, script or caption can be generated, however its own switch is set.",
    reaches: "internal",
    requires: { providers: ["ai"] },
    recipients: "Nobody. It lets the other AI switches run",
    cadence: "on-action",
  },
  publishing: {
    title: "Instagram publishing",
    onEffect: "Approved videos would be posted to a connected Instagram account.",
    reaches: "clients",
    blocked: "No credentials exist: this needs a Meta app, an Instagram Business account and app review. Turning it on today does nothing but record your intent.",
    requires: { providers: ["instagram"] },
    recipients: "The public, on the client's connected Instagram account",
    cadence: "on-action",
    // Never part of a pilot: TEST clients, or every client once the rollout
    // is set to everyone (programRolloutCore.PROGRAM_PILOT_GROUPS).
    launchGate: "programScope",
  },
  script_share_email: {
    title: "Approve & share → email the client",
    onEffect: "Approving (or automatically sharing) a script, and releasing a strategy, also EMAILS THE CLIENT that it is ready — within the hour, after a 15-minute batch so several approvals become one email — instead of only releasing it to their portal. Only for the clients the rollout reaches, and only inside client hours. It shares the reminder policy's testClientsOnly lock: while that is on, only TEST clients are emailed.",
    reaches: "clients",
    requires: { providers: ["gmail"] },
    recipients: "One address per client: the first owner seat on the program, else the client's email. By email, from info@",
    cadence: "hourly",
    launchGate: "programScope",
  },
  script_auto_share: {
    title: "Share scripts without my approval",
    onEffect: "A script the hub drafted on its own is APPROVED AND RELEASED TO THE CLIENT'S PORTAL WITHOUT YOU, once it has waited the hold (two hours by default, so you can still step in) and only when it is clean: no format problem, no length warning (clearly under 30 seconds or well over a minute), drafted from the strategy that is still approved, for a topic in the month's allowance, on an active program with no open change request. Every approval and release is recorded as done automatically. Whether the client is also emailed is the separate \"Approve & share → email the client\" switch. Only for the clients the rollout reaches, and by default only TEST clients (its own testClientsOnly lock); a script drafted before a client joined the rollout is never shared on its own. With this off you approve every script before a client sees it.",
    reaches: "clients",
    // NO requires.switches (review, Sep 28). It listed script_drafting and
    // ai_runs, but the hourly sweep (scriptAutoShare.sweepAutoShare) checks
    // only its own switch: it shares drafts that ALREADY exist and spends no
    // AI. With drafting or AI turned off it goes on releasing them, while
    // readiness called it "held by a missing dependency" and the launch gate
    // read closed. A dependency listed here must be one the code enforces.
    recipients: "The client's portal (Scripts). An email only if the share email switch is also on",
    cadence: "hourly",
    launchGate: "programScope",
  },
  portal_invites: {
    title: "Portal invitations",
    onEffect: "Clients the rollout reaches can be invited to the portal by email, and people who pay for a program get their welcome email. A client outside the rollout is not invited: their access is held and released later from Settings. Until this is on, invitations only go to Jordan's verified test inboxes.",
    reaches: "clients",
    requires: { providers: ["gmail"] },
    recipients: "The invited client seat, by email",
    cadence: "on-action",
    launchGate: "programScope",
  },
  portal_login_email: {
    title: "Portal sign-in links",
    onEffect: "A client the rollout reaches who asks to sign in is emailed a magic link. Transactional — it answers a request the person just made, and is not held for quiet hours. Anyone outside the rollout keeps the shared portal link they have today and is sent nothing.",
    reaches: "clients",
    requires: { providers: ["gmail"] },
    recipients: "The client seat that asked to sign in, by email",
    cadence: "on-action",
    launchGate: "programScope",
  },
  topic_refresh: {
    // CP-07: this used to say it gated the refresh button, which was never true —
    // the button is a person's click and runs whatever this is set to.
    title: "Automatic topic bank",
    onEffect: "The hub builds each client's first topic bank on its own once their strategy is approved, and tops a pillar back up when its usable topics fall below the target (once a week at most per pillar; suggestions you have not reviewed count as stock, so an unreviewed pile stops new spend). Everything it writes is a SUGGESTION on Video Topics: no client sees an AI topic until you accept it. Spends AI credit per run (the AI runs master switch must also be on). The Refresh topics button works either way.",
    reaches: "internal",
    requires: { switches: ["ai_runs"], providers: ["ai"] },
    recipients: "Nobody is messaged. Suggestions wait on Video Topics for Jordan",
    cadence: "hourly",
  },
  topic_carryover: {
    title: "Carry unfilmed scripts into the new month",
    onEffect: "On the 1st, every scripted topic that was not filmed last month moves into the new month and takes one of its videos, with its script and every version kept. The client sees it under \"Scripted, not filmed\" and can swap it for another topic, which frees the slot. Check the list first with \"Check carry-over\" on the client's Video Topics tab. Only for the clients the rollout reaches; a pilot client carries only topics scripted after they joined, and their first carry-over is on the next 1st after joining. Nothing is sent to the client; they see it on their portal.",
    // "clients", not "internal": nothing is sent, but the carried topic is on
    // their page and occupies their allowance, which is a client-facing fact.
    reaches: "clients",
    recipients: "Nobody is messaged. The client sees the carried topic on their portal",
    cadence: "hourly",
    launchGate: "programScope",
  },
  strategy_generation: {
    title: "Strategy drafting",
    onEffect: "A discovery call can be drafted into a strategy version automatically. The draft is written by the call processor (Transcript processing), so that must be on too, and AI runs. The draft still needs Jordan's approval before anyone sees it. Turning this off also stops drafts already waiting in the queue. The Draft strategy now button works either way.",
    reaches: "internal",
    // R05 (Sep 28 2026): the ONLY automatic path is the transcript queue —
    // programOnboarding.advanceOnboarding enqueues STRATEGY_DRAFT and
    // transcriptJobs runs it (and now leaves it waiting while this is off).
    requires: { switches: ["transcript_jobs", "ai_runs"], providers: ["ai"] },
    recipients: "Nobody is messaged. The draft waits for Jordan's approval",
    cadence: "hourly",
  },
  legacy_call_sweeps: {
    title: "Old call sweeps (name matching)",
    onEffect: "Brings back the pre-mapping sweeps: Calendly bookings filed on a month by the invitee's email, and Drive meeting notes filed on a client by the NAME in the doc title (a first name alone can match). They still stand down while any Calendly mapping is enabled. Leave this off; map the dedicated event types on Settings → Calendly & calls instead.",
    reaches: "internal",
    requires: { providers: ["calendly"], config: ["noCallMapping"] },
    recipients: "Nobody is messaged. Calls are filed on client months",
    cadence: "hourly",
  },
  session_booking: {
    title: "Self-booking against Aryeo",
    onEffect: "A client's session request CREATES A REAL ARYEO ORDER AND APPOINTMENT (one order per session, on the creative they picked), reads it back and shows it as booked, instead of a request Kyle books by hand. It also lets the hub cancel or move a session it booked itself. ONLY for TEST fixtures listed in this switch's authorizedFixtureClientIds (on Jordan's test inbox) and the real clients in the program pilot with bookings ticked (Who the program may reach, below — the same one list as the program's emails); everyone else stays desk-assisted. Aryeo's customer notifications stay off; our team gets Aryeo's own notice.",
    reaches: "clients",
    requires: { providers: ["aryeo"], config: ["fixtures"] },
    recipients: "The client's booking in Aryeo, and Aryeo's own notice to our team",
    cadence: "on-action",
    launchGate: "hubWriteScope",
  },
  address_sync: {
    title: "Exact-address sync to Aryeo",
    onEffect: "When a client adds the exact filming address for a session, the hub UPDATES THAT SESSION'S ADDRESS IN ARYEO itself and reads it back, instead of leaving it on Kyle's desk. ONLY for TEST fixtures listed in authorizedFixtureClientIds and the real clients in the program pilot with bookings ticked. Two sessions sharing one Aryeo address are never changed by the hub; Kyle gets them.",
    reaches: "clients",
    requires: { providers: ["aryeo"], config: ["fixtures"] },
    recipients: "The session's address in Aryeo (no message is sent)",
    cadence: "on-action",
    launchGate: "hubWriteScope",
  },
  call_booking: {
    title: "Strategy-call booking through Calendly's API",
    onEffect: "With config mode \"API\" and a passed read-only Calendly probe, the hub BOOKS THE CLIENT'S STRATEGY CALL ON JORDAN'S CALENDLY itself (one invitee on the mapped monthly type; Calendly sends its own confirmation per the event type's settings) from a list of open times in the portal. ONLY for TEST fixtures in authorizedFixtureClientIds or the real clients in the program pilot with bookings ticked. Everyone else keeps the embedded Calendly page, where the client books and the hub only reads.",
    reaches: "clients",
    requires: { providers: ["calendly"], config: ["callApiMode", "fixtures"] },
    recipients: "Jordan's Calendly, and Calendly's own confirmation to the client",
    cadence: "on-action",
    launchGate: "hubWriteScope",
  },
  cut_transcripts: {
    title: "Transcribing delivered cuts",
    onEffect: "Delivered videos would be transcribed for captions and search.",
    reaches: "internal",
    blocked: "No speech-to-text provider is configured (this needs an OpenAI Whisper or Deepgram key). Turning it on today does nothing.",
    requires: { providers: ["stt"] },
    // Said plainly (review, Sep 28 2026): the transcript is shown in the
    // client's posting kit beside the caption. Nobody is messaged and it is
    // the client's own words from their own finished cut, so it stays
    // "internal"; whether it should follow the rollout is for Jordan to decide
    // before a speech-to-text key is ever connected.
    recipients: "Nobody is messaged. Transcripts are stored with the video, and the client sees their own cut's transcript in its posting kit",
    cadence: "on-action",
  },
  // A CLIENT-FACING PORTAL FEATURE (review fix, Sep 28 2026). It was labelled
  // internal ("drafts wait on the video for staff") while the client's own
  // "Draft a caption" button runs it and shows the draft in their portal —
  // and it was gated by this switch alone, so switching it on reached every
  // client. It reads the rollout now (op caption_assistant, in "Automatic
  // portal changes"), and readiness lists it with the other program switches.
  // A client's click is attended, so AI runs does NOT stop it (aiRuns.ts): it
  // is not listed as a requirement, or readiness would call it blocked while
  // it worked.
  caption_assistant: {
    title: "Caption assistant",
    onEffect: "CLIENTS THE ROLLOUT REACHES get a \"Draft a caption\" button on each approved video in their portal. A click drafts a caption from the final cut's transcript (or from the script when there is none) and shows it to them there, with gaps shown rather than invented. It is the client's own click, so it runs even while AI runs is off, and each draft spends AI credit. Your TEST clients, the pilot clients you named with automatic portal changes ticked, or every client once the rollout is set to everyone; everyone else keeps today's kit with no button.",
    reaches: "clients",
    requires: { providers: ["ai"] },
    recipients: "Clients the rollout reaches, on their portal (the Draft a caption button and the drafts it writes). Nobody is messaged",
    cadence: "on-action",
    launchGate: "programScope",
  },
  fact_extraction: {
    title: "Automatic fact acceptance",
    onEffect: "Facts extracted from calls on the documented low-risk fields are ACCEPTED without a person reading them, which means they reach generators and the editor brief on their own. Only facts the hub extracts on its own are auto-accepted (a person's Re-analyse still proposes), so AI runs must be on; facts from Calendly-mapped calls are extracted by the call processor (Transcript processing).",
    reaches: "internal",
    // clientFacts.createFact auto-accepts only UNATTENDED extraction, and
    // aiRuns.runAiJson refuses every unattended run while ai_runs is off: a
    // hard dependency. The processor is partial: the legacy month-transcript
    // path (cron sync contentCalls step) still extracts without it.
    requires: {
      switches: ["ai_runs"],
      partial: [{ switch: "transcript_jobs", why: "facts from Calendly-mapped calls are only extracted by the call processor" }],
    },
    recipients: "Nobody is messaged. Accepted facts reach generators and the editor brief",
    cadence: "on-action",
  },
  revision_policy: {
    title: "Review deadlines and revision rounds",
    onEffect: "CLIENTS SEE a review deadline (four business days, Mon to Fri) and how many of their two included revision rounds each video has used. A third round asks the account owner to acknowledge that an extra round may carry a $50 fee; the office then charges or waives it, and nothing is ever charged automatically. A change request after the deadline is refused and Kyle is asked to reopen it, and an expired review becomes a task for Kyle. Only for the clients the rollout reaches, and only reviews opened after you turn this on (or after the client joined the rollout, whichever is later) are held to a deadline.",
    reaches: "clients",
    recipients: "Clients the rollout reaches, on their portal (deadline and rounds). Kyle, as a task when a review expires",
    cadence: "hourly",
    launchGate: "programScope",
  },
  review_auto_approve: {
    title: "Automatic approval on expiry",
    onEffect: "When a review deadline passes with no answer, no open notes and no other hold, the hub records the approval itself (\"Automatic approval\") instead of handing it to Kyle. Needs Review deadlines on too, applies only to reviews opened after you turn this on (or after the client joined the rollout), only for the clients the rollout reaches, and by default only to TEST clients (its own testClientsOnly lock).",
    reaches: "clients",
    requires: { switches: ["revision_policy"] },
    recipients: "The client's portal shows the video as approved. Nobody is messaged",
    cadence: "hourly",
    launchGate: "programScope",
  },
  brand_change_alerts: {
    title: "Brand-change alerts to the editor",
    onEffect: "When a client changes their brand profile or uploads a brand file (or a person applies a change from a call), the editor on their work gets a bell and a Slack DM naming what changed — at most one DM per client per hour. With this off the change is still recorded, still shows as a banner on the editor's brief and still gives Kyle a task to confirm the editor has it; only the message to the editor waits. Changes made while it was off and not yet acknowledged (up to seven days old) are sent within the hour once you turn it on.",
    reaches: "staff",
    requires: { providers: ["slack"] },
    recipients: "The assigned editor, by bell and Slack DM",
    cadence: "hourly",
  },
  topic_folders: {
    title: "Topic folders in Dropbox",
    onEffect: "Every content session gets ONE FOLDER PER TOPIC inside the job's 02-RAW-Video folder in the company Dropbox, named like \"01 Pricing in week one [a1b2c3d4]\" — the bracket is the topic's permanent id, so a topic renamed later keeps its folder and its clips. Made the hour before a session and again when the photographer submits (an extra topic filmed on site gets one too). The hub never renames, moves or deletes one: a folder somebody renamed by hand is found by its bracket (or its Dropbox id) and kept. The upload page and the editor's brief link each topic to its folder. Check one TEST job's folder names before turning this on, then tell the photographers to file clips per topic.",
    reaches: "internal",
    requires: { providers: ["dropbox"] },
    recipients: "Nobody is messaged. Folders appear in the job's Dropbox",
    cadence: "hourly",
  },
  program_message_notice: {
    title: "Email clients when the office replies",
    onEffect: "When someone on the team replies on a client's Messages tab, each person on that account (owner and assistant seats, not view-only) gets ONE email saying who replied, with the reply and the sign-in link, unless they already read it on the portal. Only for the clients the rollout reaches. A second reply before they read the first does not send another. Sent only Mon to Fri before 4:30pm ET; a reply written later goes out the next working morning. Replies from the last three days that nobody has read yet are sent within the hour of turning this on — but never replies from before a pilot client joined. With this off, replies still appear on the client's page; only the email waits.",
    reaches: "clients",
    requires: { providers: ["gmail"] },
    recipients: "Each client seat (owner and assistant, not view-only) on a client the rollout reaches, by email, from info@",
    cadence: "hourly",
    launchGate: "programScope",
  },
};
