import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// RealTour Pilot operating playbook — Jordan's REAL SOPs, distilled from a year
// of his own notes/conversations. Idempotent: upserts by a stable slug id so it
// can be re-run safely. Categories render grouped in the Resources/SOP center.
const SOPS = [
  // ---- Scheduling & Booking -------------------------------------------------
  {
    id: "sop-confirmation-call",
    category: "Scheduling & Booking",
    title: "Confirmation Call — Day Before Every Shoot",
    summary: "Call the client the day before (Fri for Mon/weekend orders) to lock details + offer upgrades.",
    content: `WHEN: The day before the shoot. For Monday or weekend orders, call the Friday before.

PREP (in Aryeo): Filter Orders for tomorrow's appointments. Open the order, complete the Pre-Appointment Check-In, mark it In-Progress, and confirm the assigned photographer.

ON THE CALL (OpenPhone):
- Confirm date, time, and exact services ordered.
- Confirm property access: agent/seller meeting us, or lockbox/combo? Get the code.
- Ask what features to highlight and anything to avoid.
- Confirm the listing's go-live date.
- For video orders: confirm song/branding preferences.
- Remind them of the property prep list (beds made, counters clear of all but ~3 items, toys/dog crates away, lights working).
- Offer upgrades naturally: twilight, drone, virtual staging, 3D tour, floor plan.
- State the turnaround so expectations are set.

AFTER: Log notes on the order. Anything that needs Jordan's call (VIP, pricing, exception) becomes a task for him.`,
  },
  {
    id: "sop-scheduling-rules",
    category: "Scheduling & Booking",
    title: "Scheduling & Reschedule Rules",
    summary: "Self-book first, two firm options, protect Jordan's calendar, weather is free.",
    content: `BOOKING:
- Always push clients to self-book at realtourpilot.com/location-select — it shows live availability and locks it in. Sending the link is professional, not dismissive.
- When offering times manually, give TWO specific options with exact times (e.g. "Wed the 23rd at 11:30 AM, or Thu the 24th at 3:00 PM").
- Book on guaranteed photographer coverage, never on a "maybe." Never hinge a new client on a soft commitment.
- No Saturday shoots (family time / Sabbath protected).

PROTECT JORDAN'S CALENDAR:
- Jordan personally shoots premium/luxury and on-camera video only. Don't put low-ticket photo shoots on his calendar.
- A VIP client who is used to Jordan specifically must be cleared WITH Jordan before assigning another photographer. If we do switch, introduce the photographer by name and note they're trained to the same standard.

RESCHEDULES:
- Weather reschedule = NO fee. Proactively offer it ("we always want clear skies for your video") with two clear-sky options.
- Reschedule inside 24 hours = $150. Same-day cancellation = $125.
- Once a firm date is set, don't reopen "maybe sooner." All shoots are fixed unless changed in writing.`,
  },
  // ---- On-Site / Shooting ---------------------------------------------------
  {
    id: "sop-property-prep",
    category: "On-Site / Shooting",
    title: "Photographer Property Prep & Close-Out Checklist",
    summary: "Arrival, before shooting, and before-leaving steps. Non-negotiable.",
    content: `ARRIVAL: Park clear of exterior shots, lock the vehicle, confirm scope, Slack "arrived."

BEFORE SHOOTING (walk the property):
- Turn ON all lights, including unused rooms. Turn OFF ceiling fans.
- Remove clutter, keys, remotes, toilet paper, personal items. Toilet seats down.
- Smooth beds, fluff pillows, flatten rugs, no more than ~3 items on counters.
- Exterior: hide trash cans, hoses, tools, lawnmowers; uncover grills; open patio umbrellas.
- Frame to minimize neighboring houses.

DURING: Shoot front-to-back starting at the entrance (helps Kyle + editors organize). Use the shot list, HDR/RAW, avoid mirrors/reflections. Remove window stickers (very hard to fix in video).

BEFORE LEAVING:
- Return any moved items, lights back to how you found them.
- Lock all doors and TEST the handles. Scramble the lockbox.
- Final walkthrough.
- Slack confirmation: "doors locked, lockbox scrambled, lights off."
- Call Jordan to confirm everything above is done before leaving.

All files uploaded to Dropbox by 8 PM. Charged gear + backups every shoot.`,
  },
  {
    id: "sop-capture-standards",
    category: "On-Site / Shooting",
    title: "Filming & Capture Standards",
    summary: "60fps, shutter 2x frame rate, white balance per room, golden-hour exteriors.",
    content: `- 60fps; shutter = 2x frame rate.
- White balance per room (~3500K indoor, ~5600K daylight). True-to-life color.
- Golden-hour exteriors when possible.
- Detail, foreground, and parallax shots; consistent shot sequence for the editors.
- Drone frame rate matched to the main camera; respect FAA rules (≤400 ft, no-fly near airports — authorizations take 30–90 days and usually aren't feasible).
- STR / Airbnb: sell the experience. Amenities out and visible (coffee bar with mugs, towels on hooks, hot-tub cover off + jets on, fire pit ready). TVs filmed off (screen added in post); fireplaces filmed off (flames added in post).`,
  },
  // ---- Editing & Delivery ---------------------------------------------------
  {
    id: "sop-turnaround",
    category: "Editing & Delivery",
    title: "Turnaround Times (SLA)",
    summary: "The single source of truth. Overrides any older docs.",
    content: `Photos: next business day.
2D floor plans, virtual staging, 3D / Matterport, property websites: 1 business day.
Standard video / reel: 48 hours.
Premium cinematic / reel: 72 hours (3–4 business days for larger scope).
Monthly social content: 3–5 business days.

EDIT REQUESTS: photos same day (by 8 PM); video next day (or same day for light fixes).

Set the expectation early. "Where's my content" is the last thing we want to hear. When at risk, give a firm new window and lead with quality — never overpromise "today."`,
  },
  {
    id: "sop-editor-delivery",
    category: "Editing & Delivery",
    title: "Editor Delivery Sequence & QA Checklist",
    summary: "Edit → Dropbox → Topaz → Aryeo → Slack link. QA before it ships.",
    content: `DELIVERY SEQUENCE (in order):
1. Edit.
2. Upload final to Dropbox (05-Final-Video / 04-Final-Photos).
3. Run video through Topaz Video AI (required before final).
4. Upload to Aryeo.
5. Share the final link in Slack.
A job is only "Done" when the Dropbox final link AND the Aryeo upload both exist.

PHOTO QA: brightness, straight verticals, color consistency, light fixtures on, clutter/small items removed, shadows/people removed, grass/sky/window replacements where needed, no typos.

VIDEO QA: no reflections, correct color/white balance, no typos, correct brokerage logo, no shaky shots, clean audio (Dialogue −6 to −15 dB, Music −18 to −20 dB), licensed music only, no off-beat cuts.

Editors flag missing footage, poor audio, or unclear instructions BEFORE delivering. One free revision round per video; $75 each additional.`,
  },
  // ---- Client Care ----------------------------------------------------------
  {
    id: "sop-delivery-text",
    category: "Client Care",
    title: "Post-Delivery Text & Feedback",
    summary: "We text after delivery (no care calls — no one answers). Adapts to full vs partial.",
    content: `WHEN: Right after content is delivered. The hub drafts the message and queues it for Kyle to review and send.

THE TEXT (warm, low-pressure, no em dashes, no emojis):
- Fully delivered: "Hi [First]! We just sent everything over for [Street]. Let us know if you need anything at all. If you would like to share quick feedback on your experience, you can do that here: [feedback link]"
- Still in production (e.g. video pending): "Hi [First]! We just delivered the [photos] for [Street], and the [video] is still in production. We will have the rest over to you shortly. Let us know if you need anything. Feedback: [feedback link]"

FEEDBACK LOOP:
- The feedback link is unique per project.
- Anything the client submits pipes straight onto the project, alerts Kyle, and flags the photographer who shot it.
- Negative feedback becomes a high-priority task to resolve.
- We track ratings over time to spot patterns and rank our creatives.`,
  },
  // ---- Pricing & Fees -------------------------------------------------------
  {
    id: "sop-fee-schedule",
    category: "Pricing & Fees",
    title: "Fee Schedule & Policies",
    summary: "Reshoot, cancellation, travel, revisions, weekend, weather.",
    content: `- Reshoot / second trip: $150.
- Same-day cancellation: $125.
- Reschedule inside 24 hours: $150.
- Weekend premium: +$200 (and we generally don't shoot Saturdays).
- Travel over 100 miles round trip: $1.50/mile.
- Revisions: 1 free per video, then $75 each.
- Real twilight: $200–$250 (a separate shoot/time window; virtual twilight is the default upsell).
- Weather reschedule: NO fee.
- Non-solicitation breach (contractors): $5,000 liquidated damages.

GOODWILL: Track how many times we've eaten a fee for a client. Cover it once as goodwill while saying it won't continue, then enforce. Prefer add-ons over discounts — discounts train clients to expect them. If crediting, frame it as a one-time credit toward their NEXT shoot, never a refund.`,
  },
  // ---- Problem Handling -----------------------------------------------------
  {
    id: "sop-problem-handling",
    category: "Problem Handling",
    title: "Problem-Handling Playbook",
    summary: "Decision rules for complaints, late delivery, no-shows, refunds.",
    content: `CORE PATTERN: acknowledge once, take ownership, give the clear next step, stop talking. Use "we" not "I" for delays and credits. Always leave room for recourse ("if you have any issues, let me know").

REFUND ON DELIVERED WORK: hard no. Redirect to specific revisions (pacing, angles, music, flow).

UNSTAGED / UNPREPPED PROPERTY: that's the client's responsibility — we capture the property as it appears on arrival. Offer a paid reshoot at the standard rate, educate gently, don't do it free.

LATE DELIVERY: give a firm window, lead with quality ("I'd rather wait a day and deliver to our standard"). Don't reveal internal staffing problems. Add-on over discount.

PHOTOGRAPHER NO-SHOW: stop waiting, own it with the client without blaming the contractor by name, secure a backup immediately, give a $100 credit. Then a firm-but-professional note to the photographer (no apology, no negotiation).

VIP USED TO JORDAN: clear any photographer switch with Jordan first; introduce the substitute by name and standard.

MATTERPORT CLARITY: it's a limitation of 360 capture; explain honestly, never promise to "sharpen" scans.

CONTRACTOR ISSUES: coach, don't fire in the heat of the moment. Strike system (24–48h notice, 2 strikes → review). Raises require 30 days with zero issues.

VAGUE COMPLAINT ("it doesn't look right"): get on a call and pull out the specifics before touching the edit.`,
  },
  // ---- Communication --------------------------------------------------------
  {
    id: "sop-comms-voice",
    category: "Communication",
    title: "How We Write to Clients (Voice & Rules)",
    summary: "Warm, confident, accountable. Hard formatting + word rules.",
    content: `VOICE: warm, confident, accountable, solution-first. Never pushy, never defensive. Respond to everything the client said. Don't fabricate enthusiasm about something we don't have info on.

HARD RULES (always):
- NO em dashes. Ever.
- No bold and no emojis in texts (it makes Jordan strip them before sending).
- Banned words: "hidden gem", "gem", "move the needle", "break the mold", "deal breaker".

LANGUAGE OF LUXURY:
- "investment" not "price"
- "fully committed" not "booked"
- "thank you for your patience" not "sorry"

PATTERNS:
- Two scheduling options with exact times.
- Push the self-book link.
- Acknowledge once, then move forward (one apology per update is enough).

SIGN-OFF: "In the Spirit of Success, Jordan Spackman — Owner, REALTOURPILOT LLC, (215) 645-4889, www.realtourpilot.com." Client care line is staffed Monday–Friday, 9:00 AM–5:30 PM.`,
  },
];

// Remove the retired care-call SOP (we text after delivery now).
await prisma.sop.deleteMany({ where: { id: "sop-care-call" } });

let n = 0;
for (const s of SOPS) {
  await prisma.sop.upsert({
    where: { id: s.id },
    create: s,
    update: { category: s.category, title: s.title, summary: s.summary, content: s.content },
  });
  n++;
}
console.log(`Seeded ${n} playbook SOPs.`);
await prisma.$disconnect();
