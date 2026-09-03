import {
  AlertTriangle, Bell, Camera, CheckCircle2, ClipboardCheck, Clock, CloudUpload, Compass,
  Crown, FileText, FolderOpen, IdCard, LayoutDashboard, LifeBuoy, ListChecks, LogIn,
  MapPin, MessageSquare, MessageSquareHeart, MessageSquareQuote, PackagePlus, PlayCircle, Plug,
  RefreshCw, RotateCcw, Scissors, SlidersHorizontal, TrendingUp, Upload, Wallet,
  type LucideIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// THE WALKTHROUGH GUIDES — one per role, written for the person doing the job
// (go-live, Sep 2026). Every step below is a thing the hub actually does: the
// button labels are the labels on screen, the hours are the hours the crons and
// the settings defaults really use, and nothing here describes a screen that
// doesn't exist.
//
// Content lives in code, not in the Sop table, on purpose: the Sop rows are
// Jordan's business SOPs (how we shoot, how we write to clients) and are edited
// from the outside; these are software walkthroughs that must change in the same
// commit as the software. They render through the same <Markdown> primitive the
// SOP Center uses, so they read identically.
//
// MARKDOWN SUBSET (src/components/ui/Markdown.tsx): #/## headings, ### small
// caps sub-labels, -/1. lists, **bold**, > quote, | tables |, --- rules.
// It does NOT render links — that is what a section's `links` are for.
// MONEY RULE: the photographer and editor guides are creative-facing. No client
// pricing, no fee schedules, no payout percentages. A photographer's OWN pay is
// their own business and stays.
// ---------------------------------------------------------------------------

export type GuideKey = "photographer" | "editor" | "ops" | "owner";

export type GuideLink = { href: string; label: string; external?: boolean };

export type GuideSection = {
  id: string;
  icon: LucideIcon;
  title: string;
  /** Markdown body — see the subset note above. */
  body: string;
  links?: GuideLink[];
};

export type Guide = {
  key: GuideKey;
  eyebrow: string;
  title: string;
  subtitle: string;
  /** Who this guide is written for, by name. */
  who: string;
  /** The one-page runbook: the day in order. */
  runbook: { when: string; what: string }[];
  sections: GuideSection[];
  /** Who to ask when the guide runs out. */
  askLine: string;
};

// ---------------------------------------------------------------------------
// PHOTOGRAPHER — Harrison Wells, James Livingston
// ---------------------------------------------------------------------------

const PHOTOGRAPHER: Guide = {
  key: "photographer",
  eyebrow: "Walkthrough",
  title: "Photographer guide",
  subtitle: "Your day, from the drive over to the moment the shoot is on your payroll",
  who: "Harrison and James",
  runbook: [
    { when: "Night before", what: "Open My Shoots, tap tomorrow's job, read the Access & shoot brief. Lockbox code, who is home, anything special — know it before you are in the driveway." },
    { when: "On the road", what: "Directions (Apple, Google or Waze) from the top of the shoot screen. Tap On my way in the bottom bar, read the drafted text, Send text." },
    { when: "On arrival", what: "Tap Arrived. Anything wrong on site — code doesn't work, dog loose, seller still packing — goes in Flag an issue on-site straight away." },
    { when: "Shooting", what: "Work the What to capture list and tick each item. Read Don't leave without first — that is the amber box of things that come back as revisions when missed." },
    { when: "Before you drive off", what: "Everything ticked? Tap Shoot complete to text the client, then Done. Notes for the editor while it is fresh — they carry into your upload page." },
    { when: "Same night", what: "Files into Dropbox, then finish the shoot's upload page end to end and press Everything's uploaded — submit. That submit is what puts the shoot on your payroll." },
    { when: "Next morning", what: "Check My Pay for the shoot, and Quality feedback for anything to fix or carry into the next shoot." },
  ],
  sections: [
    {
      id: "sign-in",
      icon: LogIn,
      title: "Signing in, and what is in your menu",
      body: `Sign in with Google, using the email address Jordan set your account up with — there is no separate password to remember. If the login says you do not have access, you are signed into the wrong Google account, or your account has not been switched on yet: text Jordan.

Your menu is short on purpose. You get:

- **My Shoots** — your shoots, and the Quality feedback tab
- **My Pay** — your shoot pay and mileage
- **Upload Portal** — the wrap-up page for every shoot
- **SOP Center** — the standards, including the full Photography SOP
- **Training** and **Ask the Hub**

### What you will never see
Client prices, invoices, other people's pay, or the company's books. The field screens are built to keep money off them. Your own pay is the one exception, because it is yours.

On a phone the menu is the hamburger at the top left, and the bell beside it is your notifications — capture feedback, mentions, and work moved onto your plate all land there.`,
      links: [
        { href: "/shoot", label: "My Shoots" },
        { href: "/upload", label: "Upload Portal" },
        { href: "/my-pay", label: "My Pay" },
      ],
    },
    {
      id: "your-shoots",
      icon: Camera,
      title: "Your shoots",
      body: `**My Shoots** is your home screen. You only ever see shoots assigned to you — nobody else's.

- The **calendar** dots the days you are working. Tap a day to filter to it, tap it again for the full list.
- Under it, shoots are grouped by day, upcoming first, then recent.
- Each card shows the time, the address, the client, and what was ordered. A green **Complete** badge means the shoot is marked done; a blue **Uploaded** badge means its files are in.
- **Your tasks** sits at the top when something is on your plate — a mention, a callback, work moved to you. Tick it off there.
- **Work-ons for your next shoot** is the short list of habits pulled out of your recent feedback. Read it before you shoot, not after. **All feedback & stats** opens the full hub.

Tap any card to open the shoot.`,
      links: [{ href: "/shoot", label: "Open My Shoots" }],
    },
    {
      id: "shoot-screen",
      icon: MapPin,
      title: "Getting there and getting in",
      body: `The shoot screen is ordered the way the job runs: get there, get in, shoot, wrap up.

### Directions
The strip under the address has **Apple**, **Google** and **Waze**, plus a copy button for the address itself. Under it is a map: **Your route today** with every stop and the drive between them when you have more than one shoot that day, just **Location** when you have one.

### Access & shoot brief
This is the card that keeps you out of trouble. It is parsed straight from the order, so it shows only what the office actually put on the job:

- **Lockbox / door code** — printed large and in a monospaced font so you can read it one-handed
- **Getting in** — the way in, when it is not a lockbox
- **At the property** — who will be there
- **Special instructions**, **Timing**, **Order notes**
- **Special requests** in an amber box above it all — these came from the client

If the appointment has no access notes at all, the card says so plainly. That is your cue to ask before you drive.

### Flag an issue on-site
At the bottom of the same card. Type what happened — the code didn't work, the yard is a mess, a dog is loose — and press **Flag**. It lands on the job for the office and on Kyle's QC card, so nobody is surprised later and nobody has to interrogate you about it tomorrow.`,
    },
    {
      id: "client-texts",
      icon: MessageSquare,
      title: "Keeping the client posted",
      body: `The floating bar at the bottom of the shoot screen has three status texts and a message button. Nothing is ever sent automatically from here — you always see the words first.

1. **On my way** — tap it, the text is written for you with your name and the street, edit anything, press **Send text**.
2. **Arrived** — same flow, sent as you get set up.
3. **Shoot complete** — tells the client it is wrapped and heading to the editors.

A button turns green once you have sent that one.

**Message** opens a free-text box for anything else — running late, gate code failed. **Polish with AI** cleans up what you typed; you still read it and press **Send**.

If the client has no phone number on file, the buttons are greyed out and the sheet says so. Text Kyle in that case.`,
    },
    {
      id: "capture",
      icon: ListChecks,
      title: "What to capture",
      body: `The **What to capture** card is the order, turned into a checklist. Each row is a deliverable with a line under it saying what it means on site — full set, cinematic walkthrough, aerials, twilight, CubiCasa scan, and so on. Tick each one as you capture it. The count in the header ( 3/5 ) is what the Done button checks against.

### Don't leave without
The amber box above the list. It carries the order's special instructions and any request the client logged for this property. These are the things that come back as revisions when they are missed. Read it before you start, not as you pack up.

### Photo count
On a job with photos, the card shows this home's ceiling and, on the Photos row, the room-by-room budget. **The ceiling is not a goal.** A hero shot per space, one composition once, every photo adding new information.

### Video jobs
Two extra cards appear:

- **The script** — pulled from Script Studio and read-only. It is what the agent is meant to say. If no script has been written yet the card says so; check back before you press record, or ask Jordan.
- **The Agent-on-Camera playbook** — the coaching reference for directing the agent.

### Good to know for this agent
A quieter box under the list: how this agent likes to work, drawn from their profile. Useful, not a gate.

Virtual staging shows as a dashed row that cannot be ticked — nothing to capture, just shoot those rooms empty, clean and straight-on so the editor can furnish them.`,
    },
    {
      id: "wrap-on-site",
      icon: CheckCircle2,
      title: "Wrapping up before you drive off",
      body: `### Notes for the editor
Above the pay card. Anything the editor should know — the house faces west so exteriors are backlit, the seller wants the pool emphasised, skip the cluttered office. Press **Save notes**. It flows straight into your upload page, so you are not retyping it at 9 PM.

### Done
The grey **Done** button in the bottom bar marks the shoot complete. If items are still unticked it asks once whether you meant to; you can go ahead. Once complete, the bar turns into **Upload content**.

**Upload content** is always available, before or after Done — you never have to hunt for it.`,
    },
    {
      id: "cull",
      icon: Scissors,
      title: "Cull before you upload",
      body: `This is the part that decides whether the office spends twenty minutes on your job or two hours.

- **Every space gets one hero shot** — the photo you would pick if you could only show one. Supporting shots exist only to show what the hero cannot.
- **One composition, once.** No distance or zoom variations of the same angle.
- **Every photo must add new information.** "I like both" is not a reason.
- **Open-concept areas are one space**, not four rooms' worth of angles.
- **5-bracket JPG.** A bracket set counts as one composition. Not RAW, not 3-bracket.
- **Trash cans and pet items are a no-go.** Fix it on site — do not lean on the editor.
- **Alternates go to Backup Photos**, and cull that folder too.

Gallery targets run by home size — roughly 25 to 35 finals on the smallest homes, up to 70 to 85 on the largest. Your upload page prints the exact range for the home you just shot.

A production charge can be deducted per clearly unnecessary photo — duplicates, distance variations, backups uploaded as finals. You are never charged for photos a property genuinely needed. The full rule is in the Photography SOP.`,
      links: [{ href: "/resources/photography-sop", label: "Photography SOP" }],
    },
    {
      id: "upload-page",
      icon: Upload,
      title: "The upload page, step by step",
      body: `**Upload Portal** lists your shoots newest first — Today's jobs, Yesterday, Past 7 days. A blue **Submit to add to payroll** chip means that job's page is not finished yet. An amber **Over budget** chip means the raw pile is past what this home should need — cull it before it goes to edit.

Open a job and the page is a numbered checklist. The steps you get depend on what was ordered, so a photo-only job never sees the video step.

### 1 · Upload everything to Dropbox
Three folder buttons with live file counts: **Raw Photos**, **Raw Video**, **Backup Photos**. Culled extras go in Backup Photos — they are kept, never edited, never delivered. A chip above shows your raw photo count against this home's budget.

### 2 · The photo standard — run your cull
This home's target in plain numbers, the standard restated, a room-by-room guide you can open, and four boxes you must tick: **Coverage**, **Culling**, **Quality**, **Count**.

### 3 · Shot order — front to back?
Two taps for the normal cases: **Front to back**, or **Interior front-to-back, then exterior**. Had to work around a seller or a contractor? Pick **Different order** and type the order you actually shot. Nobody is annoyed by that — they are annoyed by having to guess what's where.

### 4 · Anything to remove in editing?
Trash cans in exterior 3 and 4, dog bed in the primary, neighbour's car in the driveway. If the scene was clean, tick **Nothing needs removal — I checked**. One of the two is required.

### 5 · Video — script and your instructions
Only on video jobs.

- The script from Script Studio is shown. Press **Delivered as written**, or **Changed on site — edit it** and fix the text so the editor cuts to what was really said.
- **Edit style**: Fast-Paced, or Timeless & Elegant (Cinematic). Ask the realtor on site which they want. Never guess, just ask. Monthly content clients are always Personal Branding and there is no dropdown.
- Brief the editor in sections: **Vision for the edit** (required), Summary, Shots that must be shown, Things to avoid, Realtor requests, Additional notes.
- Agent-intro packages ask for the **intro script** typed word for word as filmed.
- Monthly plans ask **how many videos did you film** — that number is what the editor cuts.

### 6 · Check off and wrap up
Tick each deliverable as its files land. If something genuinely could not be done, use **Can't complete this? Tell the admin why** and say why — an unticked box with no reason tells the office nothing. Add anything else for the editor, flag a problem if there is one.

Then **Everything's uploaded — submit**. The editors are notified, the editor brief is built, and the shoot goes on your payroll. If something is still missing the page tells you exactly what, at the top, in red.

After submitting there is a one-line feedback box. It goes straight to Jordan.`,
      links: [{ href: "/upload", label: "Upload Portal" }],
    },
    {
      id: "added-at-shoot",
      icon: PackagePlus,
      title: "Something added at the shoot",
      body: `Under the steps there is a card called **Added at the shoot**. If the agent added something on site that was not on the order — an extra twilight, a drone add-on, a second reel — press **Add an item**, name it, and add a note about who asked and what was agreed.

That becomes a job for the office to put on the order. The row shows **waiting on the office** until Kyle handles it, then flips to **added to the order**. You never price it and you never invoice it — you just make sure it does not get forgotten.

Under that, **How did the shoot go?** — **Went smoothly** or **Had issues** plus a note. That is the debrief: access, parking, the property, anything the office should change on their end.`,
    },
    {
      id: "pay",
      icon: Wallet,
      title: "Your pay",
      body: `**My Pay** shows your money and nobody else's.

- **Total pay this year** at the top, with shoot pay and mileage split out.
- Three period buttons: **Getting paid** (the closed period waiting on its payday), **Current**, and **Next**. The green chip on the right says which day it pays.
- **Shoots** lists each job in the period with the date, the agent, and the pay for it.
- **Mileage** lists the days you drove, the miles driven and the miles paid — the first miles each way are on us, and the card says the exact radius on your profile.
- **Pay history** lists every closed period; tap one to open it.

Pay periods run two weeks and pay out the Friday after they close.

### If something looks wrong
Every shoot row has a flag button, and there is a **Something not adding up?** box for a question about the whole period. Both go straight to Jordan — you do not have to chase anyone.

The shoot screen also shows your pay for that one job, with travel, as an estimate. Final pay is confirmed on payout day and may combine with other shoots that day for travel.

Remember: a shoot appears in My Pay once its upload page is submitted.`,
      links: [{ href: "/my-pay", label: "My Pay" }],
    },
    {
      id: "feedback",
      icon: MessageSquareHeart,
      title: "Your quality feedback and your numbers",
      body: `The **Quality feedback** tab on My Shoots is the receiving end of every review of your work.

Six tiles across the top:

- **To fix** — open fix notes on your shoots
- **Awaiting re-review** — the ones you have marked fixed
- **Coaching** — keep-in-mind notes for next time, not this job
- **Notes / 10 shoots** — how often notes land on your work. Lower is better, and the tile tells you what it was in the previous window.
- **Clean streak** — shoots in a row with zero notes
- **Client rating** — the average from clients who rated their delivery

Under the tiles, **What clients are saying** shows recent praise. Then your open notes, grouped by shoot. Open one, reply in the thread, and press **Mark fixed** when it is handled — that moves it to awaiting re-review, and Jordan sees it.

Notes on a specific shoot also appear on that shoot's own screen, so you get them wherever you are looking.`,
      links: [{ href: "/shoot/feedback", label: "Quality feedback" }],
    },
    {
      id: "texts",
      icon: Bell,
      title: "Texts and pings you will get",
      body: `- **7 PM** — one text listing the shoots you did today, with the link to your upload portal. It is one text per evening, not one per job.
- **10 PM** — a nudge if any of today's upload pages is still not submitted.
- **The bell** in the hub — capture feedback, mentions, work moved onto your plate.

Both evening texts are switchable and their hours are set in Settings by Jordan, so if they ever feel wrong, say so rather than working around them.`,
    },
    {
      id: "trouble",
      icon: LifeBuoy,
      title: "When something goes wrong",
      body: `- **Can't get in / property not ready** — flag it on the shoot screen, then text the client from the bar, then text Kyle.
- **Client asks for something not on the order** — shoot it if it is reasonable and log it under Added at the shoot. Pricing is never your conversation.
- **Client is unhappy on site** — do not negotiate. Say you will have the office follow up, then tell Kyle.
- **The page will not submit** — it tells you what is missing at the top in red. If it still refuses, screenshot it and text Kyle; the file upload to Dropbox is what matters most and that is already done.
- **Something about your pay** — flag it on the row in My Pay.`,
    },
  ],
  askLine: "Anything this guide does not answer: text Kyle for the job, Jordan for pay and anything about money.",
};

// ---------------------------------------------------------------------------
// EDITOR — John Mark, Kim Miguel (Manila)
// ---------------------------------------------------------------------------

const EDITOR: Guide = {
  key: "editor",
  eyebrow: "Walkthrough",
  title: "Editor guide",
  subtitle: "Your queue, the brief, the raw and the final, and how a cut gets approved",
  who: "John and Kim",
  runbook: [
    { when: "Start of your day", what: "Open the Editing Room. Not Done is your list — top to bottom, oldest due date first. Anything in red is late." },
    { when: "Picking up a job", what: "Click the row. That opens the job page: the tracker at the top says where it stands and when it is due." },
    { when: "Before you cut", what: "Read What to make for the style spec and examples, then Edit instructions — the order note, what the photographer wrote at the shoot, the vision and style." },
    { when: "Getting the footage", what: "Media, then RAW footage. Brand assets and the client's logo shelf are in the same card." },
    { when: "Cutting", what: "Set the queue status to In editing so everyone can see it moving." },
    { when: "Done", what: "Send to Review, then Upload version 1 on that cut. Add a Message for the reviewer if there is anything they should know." },
    { when: "If it comes back", what: "Red banner at the top of the job: N notes to fix on this cut. Tap a timestamp to jump the player there, reply in the thread, Mark fixed, then upload the next version." },
    { when: "When it is approved", what: "Nothing to do. The file is copied into the job's Final folder in Dropbox and the cut is marked complete automatically." },
  ],
  sections: [
    {
      id: "sign-in",
      icon: LogIn,
      title: "Signing in, and what you can see",
      body: `Sign in with Google, using the work email address your account was set up with — there is no password to remember. If you were sent an invite and never opened it, open it first: until you do, the login will turn you away.

Your menu is deliberately small:

- **Editing Room** — your home screen
- **Style Guide** — every video type, its style spec and real examples
- **SOP Center** — the editing standards
- **Training** and **Ask the Hub**

You do not get the dashboard or the company task board. Everything you need for a job lives on that job's page.

### Money never reaches you
Client prices, invoices and payouts are stripped from every screen you can open. If a client's own message mentioned price, you will see the rest of it and a line saying a note was held back — ask Jordan if it matters.`,
      links: [
        { href: "/editing", label: "Editing Room" },
        { href: "/resources/video-styles", label: "Video Style Guide" },
      ],
    },
    {
      id: "queue",
      icon: ListChecks,
      title: "Your queue",
      body: `The queue shows only jobs assigned to you, in the same table Jordan sees.

Three views: **Not Done**, **Upcoming** (shoots that have not happened yet), **Done** (finished in the last 60 days).

Each row carries:

- **Task** — the address and the client, plus a red priority chip and an amber **N revision asks** chip when the client has asked for changes
- **Video type** — Standard, Premium or Personal Branding, and the actual deliverable names underneath
- **Status** — see the ladder below
- **Due** — the delivery date. Red and marked **late** when it has passed.
- **Videos** — how many finished videos this job owes
- **Links** — **RAW** and **Final** open the Dropbox folders. The dot is green when files are actually in there, hollow when the folder is still empty. That check refreshes about once an hour, so a file you dropped a minute ago may not have coloured it in yet. **Script** means a script is on file.
- The last column is the number of messages on the job.

### The status ladder
**Waiting** and **Ready for editing** set themselves — the hub watches the raw folder, so a photographer uploading flips the job to ready without anyone telling you. You choose the rest: **In editing**, **Ready for review**, **Revisions**, **Completed**.

Click anywhere on a row to open the job.`,
    },
    {
      id: "job-page",
      icon: FileText,
      title: "Opening a job",
      body: `The job page is ordered as: where the media is, what to make, how to make it, do the work, who it is for.

### The tracker, at the top
Where this edit stands in one line — booked, in the edit, ready for review, changes requested, done — plus the **Deadline** with a live countdown, the shoot date, the photographer, and the song when there is one. Every round you have sent is listed underneath with its verdict.

### What to make
One block per deliverable, each with its style tier, the style chips for that type, a short note, and links to real example videos. **Full Style Guide** opens the whole reference.

### Edit instructions
One card with everything you have been told to do:

- the customer's own words from the order intake
- what the photographer wrote on the upload page: their **vision for the edit**, the **style**, shots that must be shown, areas to avoid, realtor requests
- **how many videos** were filmed, on monthly jobs
- whether the script was **delivered as written** or changed on site
- **Additional notes** — the office's own note for this job, last

### The script
Read-only, pulled automatically from Script Studio. Copy overlay text from here rather than retyping it — retyping is the single biggest source of typo revisions. If no script exists yet, the card says so; cut B-roll first or ask in the chat.`,
    },
    {
      id: "client-wants",
      icon: MessageSquareQuote,
      title: "What the client wants",
      body: `Three different things, kept apart on purpose:

- **The work order** — only appears when a job has been bounced back. The client's ask, split into items you can tick off one at a time, with their full message kept underneath. When it is there, it is the job.
- **How they like it** (right side) — their standing preferences: the note the office keeps on file, and anything they typed themselves on their client portal. Not instructions for this job, but how they always want things.
- **The client's working profile** (right side) — how much hand-holding they want, their brand, dos and don'ts, built from past jobs.

Below them, folded away, is **Coaching & reference** — the Agent-on-Camera playbook, there when you want it.`,
    },
    {
      id: "media",
      icon: FolderOpen,
      title: "Where the media lives",
      body: `The **Media** card, first in the column right under the tracker (so the RAW download can be running while you read the rest):

- **RAW footage** — the Dropbox folder the photographer uploaded into
- **Final footage** — where finished cuts live
- **Brand assets (logo, fonts)** — the client's folder, when they have one
- **Client assets** — logos, endcards, brand kit, with the file list right there. You can upload to it too.
- **Brand colors** — the client's hex codes, ready to copy

Raw video always comes from Dropbox. Finished cuts do not have to: uploading through the hub is the normal path now, and the hub puts the approved file into the Final folder for you.`,
    },
    {
      id: "upload-cut",
      icon: CloudUpload,
      title: "Uploading a cut",
      body: `**Send to Review** is where a finished cut goes in. It lists every video this job owes — one row per video, so a monthly package with four videos has four rows, each with its own status and its own button.

1. Press **Upload version 1** on the row (**Upload version 2**, and so on, after that). Pick the file — MP4, MOV, M4V or WEBM.
2. The file goes straight from your browser to the hub in resumable parts, with a progress bar. It does not pass through a server, so a big file is fine.
3. **Message for the reviewer** — use it. "No border version", "client's logo added", "could not fix the audio at 0:42". If you write it before uploading, it is sent with the version; if the version is already with the reviewer, editing it updates what they see.
4. When it lands, the row shows **v1 in review** and the cut appears on Jordan's Review Room desk.

If you exported straight into the Dropbox Final folder out of old habit, open the fold-away line under the uploader — **Already dropped a file in the Final footage folder instead?** — and press **Done — send to review**. That takes the newest file in the Final folder and files it for review the same way. Nothing in the Final folder reaches the reviewer until you do one of those two things, so do not assume a file sitting in Dropbox has been seen.`,
    },
    {
      id: "verdict",
      icon: RotateCcw,
      title: "Approved, or sent back",
      body: `Once a cut is with the reviewer, its row tells you exactly where it stands:

- **v1 in review** — waiting on a verdict
- **Changes requested on v1** — it came back, with notes
- **Approved · copying to Dropbox**, then **Approved · in Dropbox** — done

### When it is approved
There is nothing for you to do. The hub copies the file into the job's Final folder in Dropbox and marks that cut complete. The queue row moves to Completed on its own.

### When it comes back
The top of the job page shows a red bar: **N notes to fix on this cut**, with **Go to your cut**.

Your cut plays right there, with the reviewer's notes underneath:

- Tap a **timestamp** and the player jumps to that exact moment and pauses.
- Open a note to read the thread and reply. Type @ to tag someone.
- Press **Mark fixed** when it is handled — it moves to "Fixed — awaiting re-review" so the reviewer knows to look again.
- You can leave notes of your own: **Add a note at the current moment** captures the timestamp you are paused on.

Then upload the next version on the same row. The button is red on a redo, so you cannot mistake it for a fresh job.`,
    },
    {
      id: "revisions",
      icon: RefreshCw,
      title: "How revisions reach you",
      body: `A client's change request arrives three ways at once, so you cannot miss it:

1. Your queue row gets an amber **N revision asks** chip and the status shows **Revisions**.
2. The job page grows the **work order** card at the very top — their ask split into tick-off items, their own words kept whole underneath. Tick items as you do them.
3. The bell in the hub gets a notification with a link straight to the job.

You get pinged in the hub, not on your phone at 3am — see the time zone note below.

For anything that is a conversation rather than a task, use the job's **Project chat** at the bottom of the page, or the **Messages** centre off the queue: every job's thread in one place with unread dots. Type @ to tag someone in either one.`,
      links: [{ href: "/editing/messages", label: "Messages" }],
    },
    {
      id: "timezones",
      icon: Clock,
      title: "Time zones and deadlines",
      body: `**Every date and time in the hub is Eastern time (ET)** — the office's clock, not yours. A due date of "Sep 4" means end of Sep 4 in Virginia.

Manila runs **12 hours ahead of Eastern** in US summer and **13 hours ahead** in US winter. A deadline that reads Thursday in the hub is Thursday evening or Friday morning for Kim. When in doubt, the countdown on the tracker is the honest answer — it counts real hours, not calendar days.

### The promises the deadlines come from
| Work | Promise from the shoot |
| --- | --- |
| Standard reel or video | 48 hours |
| Premium reel or video | 72 hours |
| Monthly content batch | 10 business days |

Those are the live settings; Jordan can change them, and the due dates follow automatically.

### Working hours
The office runs Monday to Friday, 9am to 6pm ET. Shoots happen on Saturdays, so footage often lands over the weekend. Nobody expects a reply from you outside your own working hours — work pings land in the bell, and the hub deliberately does not text an offshore editor during their night.`,
    },
    {
      id: "help",
      icon: LifeBuoy,
      title: "When you are stuck",
      body: `- **No raw footage in the folder** — check the RAW dot on your queue row first (it refreshes hourly). Still empty near the deadline? Say so in the job's chat and tag Kyle.
- **No script** — the card says so. Cut what you can and ask in the chat.
- **The brief contradicts the client's ask** — the work order wins, then the photographer's vision. Ask in the chat rather than guessing.
- **A note mentions money** — it was held back on purpose. Ask Jordan.
- **The upload failed** — the row keeps your message and the error. Try again; nothing is lost. If it keeps failing, use the Final-folder rescue hatch and say so in the chat.
- **Your queue is empty and should not be** — your login may not be linked to your editor profile yet. The queue tells you if so. Ask Jordan.`,
    },
  ],
  askLine: "Job questions go in the job's chat so they stay with the work. Anything about access or your account: Jordan.",
};

// ---------------------------------------------------------------------------
// OPS MANAGER — Kyle Smith
// ---------------------------------------------------------------------------

const OPS: Guide = {
  key: "ops",
  eyebrow: "Walkthrough",
  title: "Ops manager guide",
  subtitle: "The shape of the day, the screens that carry it, and what goes to Jordan instead of you",
  who: "Kyle",
  runbook: [
    { when: "9:00", what: "Ops Day, Morning Control Tower. Six numbers across the top; today's shoots underneath. Know what could go wrong before it does." },
    { when: "9:30", what: "QC + Morning Deliveries. Only what is due today. Work each card, deliver what is finished." },
    { when: "10:15", what: "Overdue Check. Everything past its promised date gets a decision: chase, close, or tell the client." },
    { when: "10:30 · 2:00 · 5:00", what: "Client communication sweeps. Nobody waits wondering whether we got their message." },
    { when: "11:00", what: "Tomorrow prep — every shoot assigned, with access notes. Fix tomorrow today." },
    { when: "11:30", what: "Open loops. What am I waiting on that could become a problem?" },
    { when: "1:00", what: "Video Review. Every uploaded cut gets a verdict today — approve it or send it back with notes." },
    { when: "1:30", what: "Pipeline check — what is holding each active job up, before the client asks." },
    { when: "3:10", what: "Monthly content check — the personal-branding batches, on their own rhythm." },
    { when: "3:30", what: "Next-day finalisation. Tomorrow is locked in." },
    { when: "5:30", what: "Daily closeout. Six checks, and anything that needs Jordan goes to Jordan tonight, not tomorrow." },
  ],
  sections: [
    {
      id: "home",
      icon: Compass,
      title: "Your home screen",
      body: `Signing in lands you on **Ops Day**. It is Jordan's daily operations structure turned into a live screen: the block you are in right now is outlined and marked **Now**.

### The six numbers
Shoots today · Unanswered clients · QC due today · Overdue · Videos to review · Tomorrow gaps. Each one is a link to the block that holds that list, and each number is counted from that same list — if it says 4, opening it shows 4 rows.

### The jump bar
Every block with its start time and how much is waiting in it. Use it instead of scrolling.

### The blocks
Each block states its goal in one line and then shows the real work, not a reminder to go and find it. A green **clear** badge means the block is genuinely empty.

The page refreshes itself, so it stays honest while it sits open on your second screen.`,
      links: [{ href: "/ops", label: "Ops Day" }],
    },
    {
      id: "qc",
      icon: ClipboardCheck,
      title: "QC and morning deliveries",
      body: `The 9:30 block holds **only what is due today**. The backlog has its own block at 10:15 so it cannot bury today's work.

Each QC card reads the same way:

- **Ordered** — what the job owes
- **Live on Aryeo** — what has actually been published, and how many of your checks are ready right now because of it
- **Still owed** — what is missing, and when the next piece is due
- **Video** — where the cut is, with a link that says **review it** or **open edit**
- **Dropbox** — raw and final file counts. "not read this pass" means the check did not consult Dropbox on that run; it does not mean the folders are empty.
- **From the shoot** — the photographer's own words: flags, what they could not complete and why, shot order, what to remove, anything else for the editor. In full, not clipped.

The chip on the right says **N ready now** when media is live and checks are actionable, or **N checks left** when you are still waiting on media. Checks tick themselves as each category goes live, so a card that is waiting is not a card you have to poke.

### The buttons on every card
**Mark complete** (asks why, and that reason lands on the project timeline — use it when an item was removed from the order or handled elsewhere), **Aryeo**, **Project**, and **Review video** when a cut is waiting.

Monthly content batches are deliberately kept out of the QC pile and given their own 3:10 block — they run on a 10-business-day window and mixing them into listing QC makes both look wrong.`,
    },
    {
      id: "video",
      icon: PlayCircle,
      title: "Video review",
      body: `The 1:00 block has two lists:

- **Waiting on your review** — cuts an editor has uploaded. Each row is one video, with its version number, who sent it, and how long it has been waiting. Anything over two days goes red. **Review** opens it.
- **In revisions** — cuts you sent back, still with the editor, with the number of notes still to fix. **Open edit** shows you the job.

### Giving a verdict
The review workspace plays the cut and takes timestamped notes. Pause where the problem is, write the note, and choose the lane: **Editor — fix**, **Editor — coaching**, or **Photographer — capture**. The lane decides who gets it and where it shows up.

Then either **Approve cut** or **Request changes**. Approving copies the file into the job's Final folder in Dropbox and marks that cut complete. Requesting changes sends it back to the editor with the notes attached and puts the job into Revisions.

The **Review Room** is the same work gathered across every job — cuts waiting, cuts in revisions, photo sets in QC, and open feedback by lane. Use Ops Day for the day's rhythm and the Review Room when you want the whole picture.`,
      links: [
        { href: "/review", label: "Review Room" },
        { href: "/ops#video-review", label: "Video Review block" },
      ],
    },
    {
      id: "loops",
      icon: RefreshCw,
      title: "Open loops",
      body: `The 11:30 block answers one question: what am I waiting on that could become a problem?

It splits three ways:

- **Yours, due now** — overdue or promised today. These render first.
- **Not due yet** — listed so nothing creeps up on you.
- **With someone else — chase, don't do** — waiting on another person. The count of overdue ones is called out without expanding the list.

Every row has **View** and **Handled**. Handled closes the loop from right here; you never have to leave the page to tidy up. The badge counts what needs a move today, so "none due" with rows still open is the honest reading, not a lie.

The same loops appear on the dashboard, eight at a time, with the same buttons.`,
      links: [{ href: "/ops#loops", label: "Open loops" }],
    },
    {
      id: "comms",
      icon: MessageSquare,
      title: "Client communication",
      body: `Three sweeps a day — 10:30, 2:00, 5:00 — all showing the same list: clients who wrote to us and have not had an answer, with how long they have waited. Over 24 hours goes red.

- **Reply** on a row opens the replies view, where every unanswered inbound message already has a draft you can edit or replace.
- **Clear the queue** opens the Comms tab of the Tasks hub, grouped by sender.

### Texts that send themselves
Two kinds go out without you: **shoot confirmations** about 48 hours before the shoot, and **delivery texts** once Aryeo shows everything on the order is live. They only send inside the window set in Settings → Automated texts — **9am to 4pm ET** today. Nothing goes out in the evening; it waits for the next morning. A client with several listings gets at most one automatic text per pass.

Everything else waits for a human. The comms **Outbox** holds drafted texts ready to send, and the dashboard's **texts to send** chip counts exactly that list.

### The rest of the Tasks hub
**Comms** (phone and email), **Revisions**, **Slack**, **Other** (the general queue, including anything that needs assigning), and **Done** (today's ledger).`,
      links: [
        { href: "/communications?tab=replies", label: "Replies" },
        { href: "/tasks?tab=comms", label: "Tasks · Comms" },
        { href: "/communications?tab=outbox", label: "Outbox" },
      ],
    },
    {
      id: "shoots",
      icon: Camera,
      title: "Shoots, today and tomorrow",
      body: `The Morning Control Tower lists today's shoots with the time, the address, an Aryeo link, and whether the photographer has submitted their upload page. The 11:00 and 3:30 blocks show tomorrow's with the gaps called out — an unassigned shoot, missing access notes.

By the end of the 3:30 block, tomorrow should have no gaps. That is the whole test.

You can open any shoot's field screen the photographer sees, straight from the schedule or from a shoot card, which is the fastest way to check whether the access notes are actually usable.

The evening looks after itself: at **7 PM** every photographer with shoots today gets one text listing them with the upload link, and at **10 PM** anyone with an unsubmitted page gets a nudge. Your closeout checklist tells you who is still outstanding before that second text goes.`,
      links: [{ href: "/schedule", label: "Schedule" }],
    },
    {
      id: "escalate",
      icon: AlertTriangle,
      title: "What you decide, and what goes to Jordan",
      body: `The priority order, when everything is shouting at once:

1. Active client issue happening right now
2. Today's shoot
3. Today's delivery
4. Tomorrow's shoot
5. Overdue project or revision
6. Client communication
7. Production follow-up
8. Routine admin
9. Long-term internal projects

> Escalate exceptions, not routine. Jordan does not need "a project was delivered."

Bring him in when:

- a client is seriously unhappy
- a client wants something outside scope, or against policy
- an important relationship is at risk
- a major production mistake happened
- tomorrow cannot be staffed
- the decision is above your authority

Everything else — handle it. And anything about **price, refunds, discounts or credits is his**, not yours: your login does not carry Finance or Trends, which is deliberate.

The daily closeout block is where escalation happens: run its six checks and send Jordan what is left tonight, not tomorrow.`,
    },
    {
      id: "pings",
      icon: Bell,
      title: "What the hub sends you",
      body: `- **Morning Slack DM**, between 8 and 10am ET — overdue items, today's list, and how many client texts are drafted and ready.
- **4 PM Slack DM** — open to-dos and things to check before the day closes.
- **Ops alerts** — raw files still missing about 30 hours after a shoot (you get a chase task, the photographer gets the nudge), and photos shot yesterday that still have not reached the client.
- **The bell** in the hub — mentions, revisions raised, new bookings and cancellations.

None of these replace Ops Day; they are the nudge when you are not looking at it.`,
    },
  ],
  askLine: "Anything that is a decision about money, scope or a relationship goes to Jordan. Everything else is yours.",
};

// ---------------------------------------------------------------------------
// OWNER — Jordan (and Lauren)
// ---------------------------------------------------------------------------

const OWNER: Guide = {
  key: "owner",
  eyebrow: "Walkthrough",
  title: "Owner guide",
  subtitle: "What runs itself, what still needs you, and where every number on screen comes from",
  who: "Jordan and Lauren",
  runbook: [
    { when: "Morning", what: "Dashboard. If it says You're clear, it is — the banner is computed from every chip on the page, not a guess. Otherwise the chips are your list." },
    { when: "Your own day", what: "My Day — your to-dos and your planned day, separate from the team's queues." },
    { when: "When cuts are waiting", what: "Review Room. Approve or send back with timestamped notes. This is the one queue only you and Kyle can clear." },
    { when: "Weekly", what: "Finance → Overview for true profit, Trends for where bookings are heading." },
    { when: "When something feels off", what: "Connections → Sync health. Every scheduled job's last runs, webhook rejections, and the reconcile cursor are on that page." },
    { when: "Rarely", what: "Settings for the rules (turnaround promises, automated texts, internal alerts), People → Logins for accounts." },
  ],
  sections: [
    {
      id: "runs-itself",
      icon: RefreshCw,
      title: "What runs itself",
      body: `Eight scheduled passes carry the business between logins. Each one records its run, so a job that stops shows up rather than fading quietly.

| Job | When |
| --- | --- |
| Comms scan | every 5 minutes |
| Aryeo + production sync | hourly, on the hour |
| Aryeo reconcile slices | hourly, at :30 |
| Money and housekeeping | 8:00am |
| Clients and profiles | 8:20am |
| Slow rebuilds | 8:40am |
| Photographer digest | 7:00pm |
| Unsubmitted-page chaser | 10:00pm |

### The hourly sync, in plain terms
New orders and appointments arrive from Aryeo. Orders that vanished there get flagged rather than deleted. Approved cuts finish copying into Dropbox. Shoot folders and client brand-asset folders get created. Project statuses are re-derived from real evidence — media live on Aryeo, files in Dropbox — and the QC and delivery tasks are (re)generated from that. Confirmation and delivery texts send themselves inside the 9am-4pm ET window. Missing scripts are pulled from Script Studio. Failed webhooks are retried.

### The half-past reconcile
A full pass over every Aryeo order takes longer than any single run allows, so it walks a slice at a time and remembers its place. A complete cycle finishes roughly every four hours, and Connections shows when the last full pass completed.

### Every five minutes
Gmail is scanned into tasks, Slack history is pulled, answered text threads close themselves, Kyle's two Slack digests fire in their windows, and the reply-SLA escalation pages the team when an inbound text has sat too long.

### Mornings
8:00 — Stripe, then QuickBooks, then the classification pass that Finance reads; payday pings to whoever is being paid that day; Plaid balances and categorisation; log trimming. 8:20 — the full client reconcile, segments, social plans, agency teams, a batch of AI client profiles, and each photographer's work-ons. 8:40 — the slow ones: photo counts, package margins, the growth plan.

### Evenings
7pm the photographers get their shoot list and upload link; 10pm anyone with an unsubmitted upload page gets chased. Both are switchable in Settings.`,
      links: [{ href: "/connections", label: "Connections · Sync health" }],
    },
    {
      id: "needs-you",
      icon: Crown,
      title: "What still needs you",
      body: `### Every day, if there is work in it
- **Cut verdicts.** A cut sits in the Review Room until you or Kyle approve it or send it back. Nothing times out, nothing auto-approves.
- **Escalations from Kyle** — unhappy client, out-of-scope ask, a relationship at risk, tomorrow unstaffable, or anything above his authority.
- **Anything about money.** Kyle's login deliberately has no Finance and no Trends, so pricing, refunds, discounts and credits come to you.

### Weekly-ish
- **Pay flags.** A photographer flagging a shoot or a pay period sends it straight to you.
- **The feature board** — what the team asked the hub to do next.
- **Duplicate-client decisions.** The nightly pass no longer merges look-alike clients (it deleted twelve rows the first time it tried) — it files each one as a decision for a human.

### Occasionally
- **Accounts** — People → Logins and access is where a person is invited, given a role, or switched off.
- **The rules** — Settings.
- **Reconnecting an integration** when a token expires. Connections tells you which.

### Never automatic, by design
Client texts outside the confirmation and delivery sweeps; anything that changes an Aryeo order; approving a cut; and any payment.`,
      links: [
        { href: "/review", label: "Review Room" },
        { href: "/feedback", label: "Feature board" },
        { href: "/users", label: "People" },
      ],
    },
    {
      id: "screens",
      icon: LayoutDashboard,
      title: "Your screens",
      body: `- **Dashboard** — the ten-second glance. One primary button, a row of chips, stuck jobs, today's shoots and the week ahead, videos waiting versus in revisions, open loops you can close in place, then the money strip, the 30-day pulse and the quality dials.
- **My Day** — your own to-dos and your planned day, with travel buffers. Yours alone; nobody else can open it.
- **Review Room** — cuts to review, cuts in revisions, photo sets in QC, and open feedback by lane.
- **Ops Day** — Kyle's screen. Open it when you want to see his day the way he sees it.
- **Finance** — Overview, Advisor, Jobs, People, Personal, Budget, Spending, Unpaid, Payroll, Bonus.
- **Trends** — bookings by order date, service mix, top spenders and clients going quiet.
- **Project Tracker, Schedule, Clients, Communications, Content Program** — the working surfaces.
- **Connections** — every integration, plus sync health.
- **Settings** — the rules. **People** — the humans and their logins.`,
      links: [
        { href: "/day", label: "My Day" },
        { href: "/sales", label: "Finance" },
        { href: "/trends", label: "Trends" },
      ],
    },
    {
      id: "numbers",
      icon: TrendingUp,
      title: "Where the numbers come from",
      body: `### The dashboard chips
Each chip is counted with the query of the list it opens. Open "in QC 9" and the Review Room shows nine rows. This is a rule the code holds to deliberately — the old chips counted one thing and linked to another, and every one of them has been rebuilt against its destination.

### The money strip
Delivered this month and pipeline come from the projects themselves — what has been delivered in the current month, and what is still active. Top AR is the largest delivered-and-unpaid balance.

### Finance → Overview
The true profit-and-loss engine. QuickBooks is pulled daily and every transaction is classified into the groups the page shows: editing, photographers and contractors, software and resold services, processing and bank fees, gear and tolls. Revenue is counted across all three processors. Cash in the bank and the 30-day in/out come from the live bank feed.

### Payroll and My Pay
One engine, used everywhere. Shoot pay is a percentage of the eligible services on the job — virtual add-ons like staging, twilight and declutter are excluded, which is why the invoice shown beside a shoot is smaller than the client's total. Mileage is routed for real, the free radius per person is subtracted, and a day with several shoots splits the trip. Any owner adjustment survives a recompute. What a photographer sees in My Pay is the same arithmetic as your Payroll tab.

### Deadlines and SLAs
Every due date is the shoot date plus that deliverable's promise, and the promises live in Settings → Turnaround promises. Today they are: photos, drone and twilight next morning; floor plans same window; 3D tours a day and a half; standard video 48 hours; premium video 72 hours; monthly content 10 business days.

### Ops Day and QC
Statuses are derived from evidence, not from someone remembering to update a tracker: media live on Aryeo, files in the Dropbox folders. That is why a QC card can tick its own boxes.

### Trends
Booking rate is measured by ORDER date, not shoot date, so it leads rather than lags. Per-package margins and the growth plan are rebuilt overnight.`,
      links: [{ href: "/sales?tab=overview", label: "Finance · Overview" }],
    },
    {
      id: "caveats",
      icon: AlertTriangle,
      title: "Numbers to read with care",
      body: `Everything on screen is computed honestly. These are the places where the underlying data, not the arithmetic, is soft:

- **Aryeo paid status lags.** A job can be paid in reality before Aryeo says so, so accounts receivable runs slightly pessimistic.
- **2026 expenses are incomplete** until the bookkeeping catch-up finishes, so profit is shown as provisional. Income is the sound half.
- **Dropbox counts are hourly.** A card saying "last read" earlier is telling you when it looked. "not read this pass" means it did not look — not that the folder is empty.
- **The growth plan is cached** against the numbers behind it; on a day nothing moved, it does not rewrite itself.
- **Open loops are capped** at a large number per page; when the cap is hit the count shows a plus so a truncated list is never presented as exact.
- **A shoot only reaches payroll when its upload page is submitted**, for shoots from Sep 2 2026 on. An unsubmitted page is visible on the Upload Portal and in the closeout checklist.`,
    },
    {
      id: "accounts",
      icon: IdCard,
      title: "Accounts and access",
      body: `Logins are Google sign-in against an allowlist — there are no passwords to manage. **People → Logins and access** is where you invite someone, set their role, grant or revoke an individual page, and switch an account off.

Four roles, and what each one gets by default:

- **Owner** — everything.
- **Admin** — the operations surfaces. Not the owner-only ones: My Day, Connections, and the Revenue and Payroll tabs of Finance.
- **Editor** — the Editing Room, the Style Guide, the SOP Center, Training and Ask the Hub. No dashboard, no task board, no client money.
- **Photographer** — My Shoots, My Pay, the Upload Portal, the SOP Center, Training and Ask the Hub.

Individual pages can be granted or revoked per person on top of the role, and a revoke applies on the person's very next click, not at their next login.

**View as** lets you look at the hub exactly as someone else sees it. It is read-only everywhere on purpose — a preview must never send a client a text.`,
      links: [{ href: "/users", label: "People · Logins and access" }],
    },
    {
      id: "switches",
      icon: SlidersHorizontal,
      title: "The switches you own",
      body: `**Settings** holds the rules the platform runs on; changes apply to new work within a minute.

- **Editor auto-assignment** — who new video work routes to
- **Automated texts** — whether the confirmation and delivery texts send themselves, and the hours they are allowed to send in (9am to 4pm ET today)
- **Text wording** — what those messages say
- **Turnaround promises** — the table every due date is built from
- **Internal alerts** — the 7pm photographer digest and the 10pm chaser, on or off, and at what hour
- **Review Room** — how long approved cuts are kept in the hub after they reach Dropbox
- **Product categories** — which product maps to which deliverable and tier

Kyle can open Settings too. Everything else on that list only moves when you move it.`,
      links: [{ href: "/settings", label: "Settings" }],
    },
    {
      id: "breaks",
      icon: Plug,
      title: "When something breaks",
      body: `**Connections → Sync health** is the first place to look. It shows the last runs of every scheduled job with their per-step timings, webhook rejections, any receiver still unsigned, and how far the Aryeo reconcile has walked.

Failure is designed to be loud, not silent:

- A scheduled job that fails or starts skipping steps shows red there, and a new failure pings Slack.
- A webhook that errors is retried automatically on the next hourly pass.
- Every integration fails closed. If a secret goes missing in production the door shuts rather than opening.
- Orders that disappear from Aryeo are flagged for a human instead of being deleted.

If a page itself misbehaves, the feature board at **Feedback & requests** is where anyone on the team — including the field — files it, and where you approve what gets built next.`,
      links: [
        { href: "/connections", label: "Connections" },
        { href: "/feedback", label: "Feedback & requests" },
      ],
    },
  ],
  askLine: "This guide describes the hub as it shipped for go-live. When the software changes, the guide changes with it.",
};

export const GUIDES: Record<GuideKey, Guide> = {
  photographer: PHOTOGRAPHER,
  editor: EDITOR,
  ops: OPS,
  owner: OWNER,
};

export const GUIDE_ORDER: GuideKey[] = ["photographer", "editor", "ops", "owner"];

/** One-line card blurb for the chooser + the Resources page. */
export const GUIDE_BLURB: Record<GuideKey, string> = {
  photographer: "Your shoots, getting in, what to capture, the upload page, your pay and your feedback.",
  editor: "Your queue, the brief, the media, uploading a cut, and how revisions reach you.",
  ops: "The day block by block, QC, video review, open loops, and what to escalate.",
  owner: "What runs itself, what needs you, and where every number comes from.",
};

/** The guide a role lands on. */
export function guideForRole(role: string | null | undefined): GuideKey {
  switch (role) {
    case "PHOTOGRAPHER": return "photographer";
    case "EDITOR": return "editor";
    case "ADMIN": return "ops";
    default: return "owner";
  }
}

/**
 * Who may open which guide. Creatives see ONLY their own — the ops guide carries
 * client-comms and escalation judgment, and the owner guide carries money. Kyle
 * (admin) can read the two creative guides as well as his own, because half his
 * job is knowing what Harrison and Kim are looking at; the owner guide stays
 * owner-only for the same reason his Finance tabs are.
 */
export function canOpenGuide(role: string | null | undefined, key: GuideKey): boolean {
  if (role === "OWNER" || role == null) return true; // null = local dev, gate off
  if (role === "ADMIN") return key !== "owner";
  return key === guideForRole(role);
}
