// ---------------------------------------------------------------------------
// EVERY AUTOMATIC TEXT, AS A TEMPLATE (Jordan, Oct 21 2026: "add settings to
// customize all text templates").
//
// One entry per automatic text the hub sends, to clients and to the team, and
// (Oct 22 2026) per fixed wording a person sends with one button press (the
// confirmation and delivery Send buttons, the capture feedback text): what
// it is, when it goes, its words, and the {placeholders} the sender fills. The
// DEFAULT of every entry is byte-for-byte what the code sent before this file
// existed (scripts/_drill/oct21-text-templates.ts holds the old builders and
// proves it), so nothing changes until Jordan edits one in Settings → Text
// messages.
//
// CLIENT-SAFE ON PURPOSE: this file imports NOTHING. The Settings card (a
// client component) reads it for the defaults, the chips, the live preview and
// the checks; pulling a server module in here is how the Sep 7 deploy failed
// (lib/settings dragged Node's crypto into the browser bundle: 8 Turbopack
// errors). The saved wording is read and written by the
// server half, src/lib/textTemplateStore.ts, which builds a TextTemplateSet
// with templateSet() below and hands it to the senders.
//
// What stays in code, not in a template:
//   · loops and lists — they arrive as ONE placeholder ({shootList}), already
//     numbered;
//   · the "⚙️ Realtour Hub:" marker on a team text. It is how the OpenPhone
//     webhook knows the hub wrote the text (lib/hubSms.ts), so it is not
//     anyone's to edit; the sender puts it in front of the rendered words;
//   · the clean-up a sender already did (no long dashes, no dollar amounts in a
//     note), which still runs on the rendered words.
//
// AN OPTIONAL PLACEHOLDER can be empty for a given job (" at 123 Main St" when
// the job has no street). When it is, it disappears along with the one space
// in front of it, so "Confirming your shoot {atPlace} on {when}" reads
// "Confirming your shoot on Monday…" and never has a double space. Every other
// placeholder is filled exactly as given.
// ---------------------------------------------------------------------------

export type TextAudience = "client" | "team";

export type TemplatePlaceholder = {
  readonly name: string;
  /** What it becomes, in plain words. */
  readonly means: string;
  /** What the preview shows for it. */
  readonly sample: string;
  /** May be empty for a job: then it disappears with the space before it. */
  readonly optional?: boolean;
};

export type TextTemplateDef = {
  readonly label: string;
  readonly audience: TextAudience;
  /** When it is sent, one plain sentence. */
  readonly when: string;
  /** The default wording: exactly what the code sent before Oct 21 2026. */
  readonly body: string;
  readonly placeholders: readonly TemplatePlaceholder[];
  /** Placeholders a saved wording must keep (the link, the one fact the text exists for). */
  readonly required: readonly string[];
  /** The file that sends it (for the record, not shown to anyone). */
  readonly sender: string;
  /** Part of a text built from several templates, joined with a blank line. */
  readonly partOf?: string;
  /** About pay: listed for the owner only (Kyle never sees dollar amounts). */
  readonly ownerOnly?: boolean;
};

// Generic on the name so TemplateVars<K> below knows each template's own names.
function P<N extends string>(name: N, means: string, sample: string, optional?: boolean): TemplatePlaceholder & { readonly name: N } {
  return optional ? { name, means, sample, optional } : { name, means, sample };
}

/** In the order the Settings card lists them. */
export const TEXT_TEMPLATES = {
  // ---- TO CLIENTS ------------------------------------------------------------
  client_welcome: {
    label: "Welcome text",
    audience: "client",
    when: "Once ever, to a brand-new client after their first booking (by email instead when there is no phone number on file).",
    body: "Hey {first}, welcome to Realtour Pilot! We're excited to work with you and get to know you. If you ever need anything you can call or text us right here. Your client portal is {portal}: that's your account, where you can see invoices and your content, place orders and reschedule. You can also book a free strategy call any time: {strategyCallLink}. Everything about what we do is at {website}.",
    placeholders: [
      P("first", "The client's first name", "Sarah"),
      P("portal", "The client portal address", "media.realtourpilot.com"),
      P("strategyCallLink", "The free strategy call booking link (set under Automated texts)", "https://calendly.com/realtourpilot-info/strategy-call"),
      P("website", "Our website", "realtourpilot.com"),
    ],
    required: ["portal"],
    sender: "src/lib/clientTextSweeps.ts (sweepWelcomeTexts)",
  },
  client_confirmation: {
    label: "Shoot confirmation",
    audience: "client",
    when: "Before each shoot, the set number of hours ahead (48 by default), inside the client send window. Send on the confirmation's card and Send all send these same words.",
    body: "Hi {first}! Confirming your shoot {atPlace} on {when} {forItems}. Anything we should know or want us to avoid? Looking forward to it!",
    placeholders: [
      P("first", "The client's first name", "Sarah"),
      P("when", "The shoot's day and time, Eastern", "Thursday, Oct 23, 10:00 AM"),
      P("atPlace", "\"at\" the street, or \"in\" the town when there is no street, or nothing", "at 123 Main St", true),
      P("forItems", "\"for\" what was ordered, or nothing when the order lists none", "for photos, drone, and floor plan", true),
      P("street", "The street, or \"the <town> location\", or \"your listing\"", "123 Main St"),
      P("items", "What was ordered, or \"your shoot\"", "photos, drone, and floor plan"),
    ],
    required: ["when"],
    sender: "src/lib/clientTextSweeps.ts (sweepConfirmationTexts), src/app/actions.ts (sendConfirmationText), src/app/tasks/sendAllActions.ts (listDraftedTexts) via src/lib/delivery.ts clientTextFor",
  },
  client_delivery_feedback: {
    label: "Delivery feedback ask",
    audience: "client",
    when: "Once everything ordered for a job has been delivered, inside the client send window. Send on the delivery text's card and Send all send these same words.",
    body: "Hi {first}! Now that {street} is wrapped up, how did everything go? The shoot, the turnaround, the content. Quick feedback here helps us make sure you are getting a great experience and keep making it better: {feedbackUrl} If anything is not right, just reply and we will jump on it.",
    placeholders: [
      P("first", "The client's first name", "Sarah"),
      P("street", "The street, or \"the <town> location\", or \"your listing\"", "123 Main St"),
      P("feedbackUrl", "The link to the job's feedback form", "https://hub.realtourpilot.com/feedback/abc123"),
    ],
    required: ["feedbackUrl"],
    sender: "src/lib/clientTextSweeps.ts (sweepDeliveryTexts), src/app/actions.ts (sendDeliveryText), src/app/tasks/sendAllActions.ts (listDraftedTexts) via src/lib/delivery.ts clientTextFor",
  },
  // Oct 22 2026: the two other shapes of the delivery text. The sweep never
  // sends them (it waits for the whole job); a person pressing Send on a
  // delivery text while part of the job is still owed does.
  client_delivery_partial: {
    label: "Delivery text: part delivered",
    audience: "client",
    when: "When a person presses Send on a delivery text while part of the job is still owed (the automatic one waits for the whole job): what is out, what is still coming, and the feedback ask.",
    body: "Hi {first}! The {deliveredLine}, and {remainingLine}. How is everything looking so far? If anything is not exactly right, just reply here and we will jump on it. Quick feedback means a lot to us: {feedbackUrl}",
    placeholders: [
      P("first", "The client's first name", "Sarah"),
      P("deliveredLine", "What is out, for where, and \"is\" or \"are delivered\"", "photos for 123 Main St are delivered"),
      P("remainingLine", "What is still owed and where it stands", "the video is still in production and coming shortly"),
      P("feedbackUrl", "The link to the job's feedback form", "https://hub.realtourpilot.com/feedback/abc123"),
      P("delivered", "Just what is out", "photos"),
      P("remaining", "Just what is still owed", "the video"),
      P("street", "The street, or \"the <town> location\", or \"your listing\"", "123 Main St"),
    ],
    required: ["feedbackUrl"],
    sender: "src/app/actions.ts (sendDeliveryText), src/app/tasks/sendAllActions.ts (listDraftedTexts) via src/lib/delivery.ts deliveryMessage",
  },
  client_delivery_update: {
    label: "Delivery text: nothing out yet",
    audience: "client",
    when: "When a person presses Send on a delivery text before anything ordered is on the client's listing: what is still coming, with no feedback ask.",
    body: "Hi {first}! Quick update {forPlace}: {remainingLine}. We will let you know the moment everything is up. If you need anything before then, just reply here.",
    placeholders: [
      P("first", "The client's first name", "Sarah"),
      P("forPlace", "\"for\" the street, or \"from your <town> shoot\", or \"from your shoot\"", "for 123 Main St"),
      P("remainingLine", "What is still owed and where it stands", "3 of 4 videos are finished and going up on your listing"),
    ],
    required: ["remainingLine"],
    sender: "src/app/actions.ts (sendDeliveryText), src/app/tasks/sendAllActions.ts (listDraftedTexts) via src/lib/delivery.ts deliveryMessage",
  },
  client_after_hours: {
    label: "After-hours reply",
    audience: "client",
    when: "When a client texts while the office is closed, once per closed stretch, unless the crew is with them that day.",
    body: "Hi {first}, thanks for reaching out! Our office hours are {hours}, so we will get back to you first thing {nextDay}. In the meantime you can log in at {portal} to place an order, reschedule an appointment, and grab your content and invoices.",
    placeholders: [
      P("first", "The first name of whoever texted", "Sarah"),
      P("hours", "The office hours", "Monday to Friday, 9am to 6pm"),
      P("nextDay", "When we will answer", "tomorrow morning"),
      P("portal", "The client portal address", "media.realtourpilot.com"),
    ],
    required: ["nextDay"],
    sender: "src/lib/clientTextSweeps.ts (sweepAfterHoursReplies)",
  },

  // ---- TO THE TEAM: uploads --------------------------------------------------
  upload_digest: {
    label: "7 PM upload list",
    audience: "team",
    when: "Every evening, to each creative who shot that day: the day's shoots and the upload page.",
    body: "Hi {firstName}, Realtour Pilot here.\n\nTonight's shoots to upload:\n{shootList}\n\nUpload to Dropbox, then finish each shoot's checklist here:\n{uploadLink}",
    placeholders: [
      P("firstName", "The creative's first name", "Harrison"),
      P("shootList", "Today's shoots, numbered, one per line", "1. 123 Main St\n2. 45 Oak Ave"),
      P("uploadLink", "The upload page", "https://hub.realtourpilot.com/upload"),
    ],
    required: ["shootList", "uploadLink"],
    sender: "src/lib/uploadDigest.ts (digestText)",
  },
  upload_chaser_greeting: {
    label: "10 PM upload chaser: greeting",
    audience: "team",
    when: "At the top of the 10 PM chaser, and of the late video notice.",
    body: "Hi {firstName}, Realtour Pilot here.",
    placeholders: [P("firstName", "The creative's first name", "Harrison")],
    required: [],
    sender: "src/lib/uploadDigest.ts (nagText)",
    partOf: "upload_chaser",
  },
  upload_chaser_shoots: {
    label: "10 PM upload chaser: pages not submitted",
    audience: "team",
    when: "At 10 PM, when a shoot from today still has no submitted upload page.",
    // Oct 22 2026 (comms audit, LOW): pay is fixed now and hidden from the
    // team, so the chaser no longer says the shoot goes on their payroll.
    body: "Still waiting on today's upload {pages}:\n{shootList}\n\nPlease finish tonight: files in Dropbox, then submit the page here:\n{uploadLink}",
    placeholders: [
      P("pages", "\"page\" for one shoot, \"pages\" for more", "pages"),
      P("shootList", "The shoots still waiting, numbered, one per line", "1. 123 Main St\n2. 45 Oak Ave"),
      P("uploadLink", "The upload page", "https://hub.realtourpilot.com/upload"),
    ],
    required: ["shootList", "uploadLink"],
    sender: "src/lib/uploadDigest.ts (nagText)",
    partOf: "upload_chaser",
  },
  upload_chaser_video_one: {
    label: "10 PM upload chaser: one video missing",
    audience: "team",
    when: "When a job's photos went in today but its video did not (in the 10 PM chaser, or at once when the photos go in after it).",
    body: "Photos are uploaded for {street}, but the video is not. Please upload the video and submit it before 8:00 AM tomorrow:\n{videoLink}\n\nA video that comes in after 8:00 AM counts as a late upload on your KPIs.",
    placeholders: [
      P("street", "The job's street", "123 Main St"),
      P("videoLink", "That job's upload page", "https://hub.realtourpilot.com/upload/abc123"),
    ],
    required: ["videoLink"],
    sender: "src/lib/uploadDigest.ts (nagText, sendSplitNoticeIfChaserPassed)",
    partOf: "upload_chaser",
  },
  upload_chaser_video_many: {
    label: "10 PM upload chaser: several videos missing",
    audience: "team",
    when: "The same notice when more than one job is missing its video.",
    body: "Photos are uploaded but the video is not for:\n{videoList}\n\nPlease upload each video and submit it before 8:00 AM tomorrow. A video that comes in after 8:00 AM counts as a late upload on your KPIs.",
    placeholders: [
      P("videoList", "Each job and its upload page, numbered, one per line", "1. 123 Main St: https://hub.realtourpilot.com/upload/abc123\n2. 45 Oak Ave: https://hub.realtourpilot.com/upload/def456"),
    ],
    required: ["videoList"],
    sender: "src/lib/uploadDigest.ts (nagText)",
    partOf: "upload_chaser",
  },
  upload_gap: {
    label: "Upload missing part of the order",
    audience: "team",
    when: "When a job's Dropbox upload is missing part of what was ordered, once per gap, to its creative.",
    body: "Hi {firstName}, {street} (shot {shotWhen}). Dropbox only has {held} for it. Missing: {missing}. {alsoMissing} Can you upload them? Upload page: {link}",
    placeholders: [
      P("firstName", "The creative's first name", "Harrison"),
      P("street", "The job's street", "123 Main St"),
      P("shotWhen", "\"today\", \"yesterday\" or the weekday", "yesterday"),
      P("held", "What Dropbox holds", "45 drone photos and 4 drone clips"),
      P("missing", "What is missing", "ground photos"),
      P("alsoMissing", "\"Also not there yet: …\" when something else is empty too, or nothing", "Also not there yet: video clips.", true),
      P("link", "The job's upload page", "https://hub.realtourpilot.com/upload/abc123"),
    ],
    required: ["missing", "link"],
    sender: "src/lib/uploadGaps.ts (composeGapText)",
  },
  instructions_missing_photographer: {
    label: "Missing instructions: to the photographer",
    audience: "team",
    when: "From 10 AM the morning after a shoot whose upload-page instructions are still missing, once a morning, up to three mornings.",
    body: "Hi {firstName}, {street} (shot {shotDay}) is {still} waiting on you {waitingFor}: {missingList}. Finish it here: {link}",
    placeholders: [
      P("firstName", "The photographer's first name", "Harrison"),
      P("street", "The job's street", "123 Main St"),
      P("shotDay", "The shoot day", "Tue Oct 20"),
      P("still", "\"still\" from the second morning on, else nothing", "still", true),
      P("waitingFor", "\"before editing can start\" or \"before the photos can go out\"", "before editing can start"),
      P("missingList", "What is missing", "the shot order and the cull confirmation"),
      P("link", "The job's upload page", "https://hub.realtourpilot.com/upload/abc123"),
    ],
    required: ["missingList", "link"],
    sender: "src/lib/missingInstructions.ts (composeNudgeText)",
  },
  instructions_missing_manager: {
    label: "Missing instructions: creative manager's copy",
    audience: "team",
    when: "The same mornings, to the creative manager (their bell, and a text when their notifications say so).",
    body: "Heads up: {photographerFirst} {still} hasn't sent the instructions for {street} (shot {shotDay}) yet: {missingList}. {waiting} {unreachable}",
    placeholders: [
      P("photographerFirst", "The photographer's first name", "Harrison"),
      P("still", "\"still\" from the second morning on, else nothing", "still", true),
      P("street", "The job's street", "123 Main St"),
      P("shotDay", "The shoot day", "Oct 20"),
      P("missingList", "What is missing", "the shot order and the cull confirmation"),
      P("waiting", "\"Editing is waiting.\" or \"The photos are waiting.\"", "Editing is waiting."),
      P("unreachable", "Why the photographer could not be texted, or nothing", "Harrison could not be texted (no phone on file).", true),
    ],
    required: ["missingList"],
    sender: "src/lib/missingInstructions.ts (composeManagerLine)",
  },

  // ---- TO THE TEAM: shoots -----------------------------------------------------
  shoot_day_requests: {
    label: "Shoot-day special requests",
    audience: "team",
    when: "At a shoot's start time, to its creative, when the job carries special requests.",
    body: "{street}, {time}. Special requests for this shoot: {requestList} Shoot screen: {link}",
    placeholders: [
      P("street", "The job's street", "123 Main St"),
      P("time", "The start time, Eastern", "10:00 AM"),
      P("requestList", "The requests, numbered on one line", "1) Shoot the backyard at golden hour. 2) Skip the basement."),
      P("link", "The job's shoot screen", "https://hub.realtourpilot.com/shoot/abc123"),
    ],
    required: ["requestList", "link"],
    sender: "src/lib/shootDayText.ts (composeShootDayText)",
  },
  shoot_note: {
    label: "Client note before a shoot",
    audience: "team",
    when: "When a client's note about a shoot arrives within 24 hours of it, once, to the photographer (Slack first, else a text).",
    body: "Note from the client for {street} ({when}): \"{note}\". It is on your shoot screen: {link}",
    placeholders: [
      P("street", "The job's street", "123 Main St"),
      P("when", "The shoot's day and time, Eastern", "Thu, Oct 23, 10:00 AM"),
      P("note", "The client's note (up to 300 characters)", "The dog will be in the backyard, please keep the gate shut."),
      P("link", "The job's shoot screen", "https://hub.realtourpilot.com/shoot/abc123"),
    ],
    required: ["note"],
    sender: "src/lib/shootNotes.ts",
  },
  shoot_feedback_shared: {
    label: "Capture feedback shared",
    audience: "team",
    when: "When someone in the office presses \"Text <photographer> the feedback\" under a shoot's capture feedback, to whoever shot it.",
    body: "Hey {firstName} — {author} left some feedback on your shoot for {street}. Check it out here: {link}",
    placeholders: [
      P("firstName", "The photographer's first name", "Harrison"),
      P("author", "The first name of whoever pressed the button", "Jordan"),
      P("street", "The job's street", "123 Main St"),
      P("link", "The job's shoot screen, where the feedback is", "https://hub.realtourpilot.com/shoot/abc123"),
    ],
    required: ["link"],
    sender: "src/app/projects/reviewActions.ts (shareShootFeedback)",
  },

  // ---- TO THE TEAM: pay ----------------------------------------------------------
  payday: {
    label: "Payday",
    audience: "team",
    when: "On payout morning, to a creative with pay in the closed period. Only a login that may see pay gets it (today, the owner).",
    body: "💰 Payday: {amount} lands today ({shoots} + mileage, {period}). Details: {link}",
    placeholders: [
      P("amount", "The amount landing today", "$1,234.50"),
      P("shoots", "How many shoots", "12 shoots"),
      P("period", "The pay period", "10-01–10-15"),
      P("link", "My Pay", "https://hub.realtourpilot.com/my-pay"),
    ],
    required: ["amount"],
    sender: "src/lib/payroll.ts (paydayPings)",
    ownerOnly: true,
  },

  // ---- TO THE TEAM: clients waiting --------------------------------------------
  portal_message_team: {
    label: "New portal message",
    audience: "team",
    when: "When a content program client writes on the portal, to the messages owner and Jordan (and the ops channel), at most every 10 minutes per client.",
    body: "New portal message from {clientName}: “{message}” Reply here: {link}",
    placeholders: [
      P("clientName", "The client", "Sarah Agent"),
      P("message", "Their message (up to 160 characters)", "Can we swap the Thursday shoot to Friday?"),
      P("link", "Their messages in the hub", "https://hub.realtourpilot.com/content/abc123?tab=messages"),
    ],
    required: ["message", "link"],
    sender: "src/lib/programMessages.ts (alertOffice)",
  },
  chase_owner: {
    label: "Client chased three times",
    audience: "team",
    when: "When a client asks for an update a third time in two weeks, to Jordan.",
    body: "{clientName} has asked for an update {count} times in {days} days ({what}). {promise} Kyle has a HIGH task for it: {link}",
    placeholders: [
      P("clientName", "The client", "Sarah Agent"),
      P("count", "How many times", "3"),
      P("days", "The window in days", "14"),
      P("what", "What they are waiting on", "123 Main St"),
      P("promise", "What was promised, from the job", "Promised photos by Wed, Oct 22, 5:00 PM."),
      P("link", "Kyle's task", "https://hub.realtourpilot.com/tasks?task=abc123"),
    ],
    required: ["link"],
    sender: "src/lib/chaseCounter.ts",
  },
  on_call_unhappy: {
    label: "On-call page: unhappy client",
    audience: "team",
    when: "Out of hours, when an unhappy client's text has gone unanswered, to the person on call.",
    body: "Unhappy client unanswered {vip} — {clientName}, {age}: \"{snippet}\"",
    placeholders: [
      P("vip", "\"(VIP)\" for a VIP client, else nothing", "(VIP)", true),
      P("clientName", "The client", "Sarah Agent"),
      P("age", "How long they have waited", "2h 15m"),
      P("snippet", "The start of their text", "This is really disappointing, where are my photos?"),
    ],
    required: [],
    sender: "src/lib/commsSla.ts (pageOnCall)",
  },
  on_call_still: {
    label: "On-call page: client still unanswered",
    audience: "team",
    when: "Out of hours, when a client's text is still unanswered at the second escalation, to the person on call.",
    body: "Client still unanswered {vip} — {clientName}, {age}: \"{snippet}\"",
    placeholders: [
      P("vip", "\"(VIP)\" for a VIP client, else nothing", "(VIP)", true),
      P("clientName", "The client", "Sarah Agent"),
      P("age", "How long they have waited", "4h"),
      P("snippet", "The start of their text", "Any update on the video?"),
    ],
    required: [],
    sender: "src/lib/commsSla.ts (pageOnCall)",
  },
  email_followup: {
    label: "Client email still unanswered",
    audience: "team",
    when: "When a client email has waited past the escalation hours, once per wait, to whoever holds it.",
    body: "📧 Still no reply: {clientName}'s email \"{subject}\" has waited {age} of business hours. {link}",
    placeholders: [
      P("clientName", "The client", "Sarah Agent"),
      P("subject", "The email's subject (up to 70 characters)", "Question about next month"),
      P("age", "How long it has waited, in business hours", "6h 30m"),
      P("link", "The follow-up task", "https://hub.realtourpilot.com/tasks?tab=other&task=abc123"),
    ],
    required: ["link"],
    sender: "src/lib/emailFollowUp.ts",
  },

  // ---- TO THE TEAM: the office ---------------------------------------------------
  photos_undelivered: {
    label: "Photos not delivered",
    audience: "team",
    when: "Late afternoon, to the people flagged for ops alerts, when shot jobs still have no photos on Aryeo.",
    body: "{jobs} shot and photos still not delivered on Aryeo:\n{jobList} {more}",
    placeholders: [
      P("jobs", "How many jobs", "2 jobs"),
      P("jobList", "Up to four jobs, one per line", "123 Main St (Sarah Agent) — shot 2d ago\n45 Oak Ave (Sam Broker) — shot 3d ago"),
      P("more", "\"+N more\" past four, else nothing", "+1 more", true),
    ],
    required: ["jobList"],
    sender: "src/lib/deliveryWatch.ts",
  },
  desk_task_ping: {
    label: "Urgent task on your list",
    audience: "team",
    when: "When an URGENT content program task lands (or comes back) on a person's list, to that person.",
    body: "📋 {how} your list (URGENT): {title} {due}. {link}",
    placeholders: [
      P("how", "\"New on\" or \"Back on\"", "New on"),
      P("title", "The task", "Scripts not approved 24 hours before filming: Sarah Agent"),
      P("due", "\"· due <time> ET\", or nothing", "· due Thu, Oct 23, 10:00 AM ET", true),
      P("link", "The task", "https://hub.realtourpilot.com/tasks?tab=other&task=abc123"),
    ],
    required: ["link"],
    sender: "src/lib/programDeskTasks.ts (pingDeskTask)",
  },
  review_escalation_one: {
    label: "Video waiting on review (one)",
    audience: "team",
    when: "When a cut has waited past the backup reviewer's window, to Jordan.",
    body: "Video still waiting on review past the backup window: {street} (v{round}), {hours} covered hours. {link}",
    placeholders: [
      P("street", "The job's street", "123 Main St"),
      P("round", "The version number", "2"),
      P("hours", "Covered hours waited", "18"),
      P("link", "The cut in the Review Room", "https://hub.realtourpilot.com/review/abc123?cut=def456"),
    ],
    required: ["link"],
    sender: "src/lib/reviewerAssignment.ts",
  },
  review_escalation_many: {
    label: "Videos waiting on review (several)",
    audience: "team",
    when: "The same, when several cuts crossed the window together, to Jordan.",
    body: "{count} videos still waiting on review past the backup window, oldest {street} (v{round}). {link}",
    placeholders: [
      P("count", "How many cuts", "3"),
      P("street", "The oldest one's street", "123 Main St"),
      P("round", "Its version number", "2"),
      P("link", "The Review Room", "https://hub.realtourpilot.com/review"),
    ],
    required: ["link"],
    sender: "src/lib/reviewerAssignment.ts",
  },
  review_relay: {
    label: "Relay changes to the outside editor",
    audience: "team",
    when: "When a cut by the outside editing agency is sent back with notes, to the office who relays it.",
    body: "↩︎ Relay to {editor}: {reviewer} sent back {street} (version {round}) with {notes}. They're on the edit card as round {nextRound} — {link}",
    placeholders: [
      P("editor", "The outside agency", "Luma Visuals"),
      P("reviewer", "Who sent it back", "James"),
      P("street", "The job's street", "123 Main St"),
      P("round", "The version sent back", "1"),
      P("notes", "How many notes", "3 notes"),
      P("nextRound", "The next round", "2"),
      P("link", "The edit card", "https://hub.realtourpilot.com/edit/abc123"),
    ],
    required: ["link"],
    sender: "src/app/review/actions.ts",
  },
} as const satisfies Record<string, TextTemplateDef>;

export type TextTemplateKey = keyof typeof TEXT_TEMPLATES;
export const TEXT_TEMPLATE_KEYS = Object.keys(TEXT_TEMPLATES) as TextTemplateKey[];

type NamesOf<K extends TextTemplateKey> = (typeof TEXT_TEMPLATES)[K]["placeholders"][number]["name"];
/** Every placeholder of that template, filled. A sender that forgets one does not compile. */
export type TemplateVars<K extends TextTemplateKey> = { [N in NamesOf<K>]: string };

export function isTextTemplateKey(k: unknown): k is TextTemplateKey {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(TEXT_TEMPLATES, k);
}

export function templateDef(key: TextTemplateKey): TextTemplateDef {
  return TEXT_TEMPLATES[key];
}

/** The templates a viewer may see: an ownerOnly one (pay) is the owner's alone. */
export function templatesVisibleTo<T extends { key: TextTemplateKey }>(rows: T[], isOwner: boolean): T[] {
  return isOwner ? rows : rows.filter((r) => !templateDef(r.key).ownerOnly);
}

/** The AppSetting row a saved wording lives in. */
export const TEXT_TEMPLATE_SETTING_PREFIX = "text_template:";
export const textTemplateSettingKey = (key: TextTemplateKey) => `${TEXT_TEMPLATE_SETTING_PREFIX}${key}`;

/** Longest wording a template may hold (the same cap the old boxes had). */
export const TEXT_TEMPLATE_MAX = 1000;
/** One text message; past this it goes as more than one. */
export const ONE_TEXT_CHARS = 160;

const PLACEHOLDER_RE = /( ?)\{([A-Za-z0-9_]+)\}/g;

/** The placeholders written in a wording, in order, without repeats. */
export function placeholdersIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{([A-Za-z0-9_]+)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Fill a wording. A placeholder with no value given is left exactly as typed
 * (only a wording saved before the checks existed can carry one: see
 * templateSet). An OPTIONAL placeholder whose value is empty disappears along
 * with the one space before it. Trimmed, like the old applyTemplate (lib/delivery, retired Oct 22 2026).
 */
export function fillTemplate(body: string, vars: Record<string, string>, optional: readonly string[] = []): string {
  return body
    .trim()
    .replace(PLACEHOLDER_RE, (m: string, space: string, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return m;
      const v = String(vars[name] ?? "");
      return v === "" && optional.includes(name) ? "" : space + v;
    })
    .trim();
}

const optionalOf = (def: TextTemplateDef) => def.placeholders.filter((p) => p.optional).map((p) => p.name);

/** The preview's values: every placeholder's sample. */
export function sampleVars(key: TextTemplateKey): Record<string, string> {
  return Object.fromEntries(TEXT_TEMPLATES[key].placeholders.map((p) => [p.name, p.sample]));
}

/** What the wording looks like with the sample values. */
export function previewTemplate(key: TextTemplateKey, body: string): string {
  return fillTemplate(body, sampleVars(key), optionalOf(TEXT_TEMPLATES[key]));
}

export type TemplateCheck = { ok: true } | { ok: false; problems: string[] };

const LONG_DASH = /[—–]/;
const DROPBOX = /dropbox(?:usercontent)?\.com|\bdb\.tt\b/i;

/**
 * Whether a wording may be saved (and, at send time, used). Refused:
 *   · empty, or longer than TEXT_TEMPLATE_MAX;
 *   · a {placeholder} this text does not have (a typo would go out as-is);
 *   · a brace that is not part of a placeholder;
 *   · a required placeholder taken out (the link, or the fact the text is for);
 *   · to a client: a long dash (house rule: a comma, colon or period instead),
 *     or a Dropbox link (clients get their media through the portal).
 * Team texts may keep what they have today (the chaser has a long dash).
 */
export function checkTemplateBody(key: TextTemplateKey, body: string): TemplateCheck {
  const def: TextTemplateDef = TEXT_TEMPLATES[key];
  const problems: string[] = [];
  const text = typeof body === "string" ? body : "";
  if (!text.trim()) problems.push("The text is empty. Use Reset to go back to the default.");
  if (text.length > TEXT_TEMPLATE_MAX) problems.push(`The text is ${text.length} characters; the most is ${TEXT_TEMPLATE_MAX}.`);
  const known = def.placeholders.map((p) => p.name);
  const used = placeholdersIn(text);
  const unknown = used.filter((n) => !known.includes(n));
  if (unknown.length) problems.push(`Not a placeholder for this text: ${unknown.map((n) => `{${n}}`).join(", ")}. Use the buttons below the box.`);
  if (/[{}]/.test(text.replace(/\{[A-Za-z0-9_]+\}/g, ""))) problems.push("A { or } that is not part of a placeholder. Placeholders look like {first}.");
  const missing = def.required.filter((n) => !used.includes(n));
  if (missing.length) problems.push(`This text has to keep ${missing.map((n) => `{${n}}`).join(" and ")}.`);
  if (def.audience === "client") {
    if (LONG_DASH.test(text)) problems.push("Client texts never use a long dash (— or –). Use a comma, colon or period.");
    if (DROPBOX.test(text)) problems.push("Client texts never carry a Dropbox link. Their media goes through the portal.");
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

export type TemplateSource = "default" | "saved" | "legacy";
export type TemplateOverride = {
  body: string;
  /** Wording saved in the old boxes (Text wording, the welcome box) before
   *  Oct 21 2026. It is sent exactly as it was being sent, unchecked, so
   *  nothing changes for it; saving or resetting here replaces it. */
  legacy?: boolean;
};

export type TextTemplateSet = {
  render<K extends TextTemplateKey>(key: K, vars: TemplateVars<K>): string;
  sourceOf(key: TextTemplateKey): TemplateSource;
};

/**
 * The wording each template sends: a saved wording that passes the checks, or
 * an old-box wording as it is, else the default. A saved wording that fails
 * the checks (a required placeholder gone, an unknown one) is never sent: the
 * default goes, and `warn` says why.
 */
export function templateSet(
  overrides: Partial<Record<TextTemplateKey, TemplateOverride>> = {},
  warn: (message: string) => void = () => {},
): TextTemplateSet {
  const effective = new Map<TextTemplateKey, { body: string; source: TemplateSource }>();
  for (const key of TEXT_TEMPLATE_KEYS) {
    const o = overrides[key];
    if (o && typeof o.body === "string" && o.body.trim()) {
      if (o.legacy) {
        effective.set(key, { body: o.body, source: "legacy" });
        continue;
      }
      const check = checkTemplateBody(key, o.body);
      if (check.ok) {
        effective.set(key, { body: o.body, source: "saved" });
        continue;
      }
      warn(`text template ${key}: the saved wording is not used (${check.problems.join(" ")}) — sending the default`);
    }
    effective.set(key, { body: TEXT_TEMPLATES[key].body, source: "default" });
  }
  return {
    render(key, vars) {
      const e = effective.get(key)!;
      return fillTemplate(e.body, vars as Record<string, string>, optionalOf(TEXT_TEMPLATES[key]));
    },
    sourceOf: (key) => effective.get(key)!.source,
  };
}

/** The defaults alone: what every sender uses when it is not handed the saved set. */
export const DEFAULT_TEXTS: TextTemplateSet = templateSet();

/** Fill one template. Without a set, the default wording. */
export function render<K extends TextTemplateKey>(key: K, vars: TemplateVars<K>, set: TextTemplateSet = DEFAULT_TEXTS): string {
  return set.render(key, vars);
}
