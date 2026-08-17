import "server-only";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { parseEvidence } from "@/lib/statusEvidence";
import { type ChecklistItem, parseChecklist, serializeChecklist, checklistComplete } from "@/lib/checklist";
import { etDayStartUtc } from "@/lib/datetime";
import { slugForName } from "@/lib/assignees";
import { BRACKET_RATIO, photoTargetFor } from "@/lib/culling";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// Phase 1 of the listener-first platform: turnaround rules + due-date/priority
// engine + package-driven task generation from real Aryeo projects.
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Turnaround targets in hours by deliverable type (admin-editable later).
const TURNAROUND_HOURS: Record<string, number> = {
  PHOTOS: 20, // next morning
  DRONE: 20,
  FLOORPLAN: 36,
  MATTERPORT_3D: 36,
  ZILLOW_3D: 36,
  TWILIGHT: 20,
  VIRTUAL_STAGING: 48,
  SOCIAL_REEL: 48,
  VIDEO: 48,
  HEADSHOT: 24,
  OTHER: 48,
};

// Reel/video turnaround tiers (a reel is just a vertical social video):
//   • Standard reel/video  → 1-2 days (48h)
//   • Premium reel/video   → 3 days (72h)   [label starts with "Premium"]
//   • Monthly content      → 7-10 BUSINESS days  [recurring social-plan client]
// PRECEDENCE: premium wins over monthly. A premium LISTING reel (e.g. a premium
// reel ordered with a property shoot) is a one-off premium deliverable, NOT
// recurring monthly content — so it keeps the 3-day premium SLA even when the
// client is on a social plan. Only NON-premium reels for a social client use the
// monthly window. Premium-ness rides on the deliverable LABEL ("Premium Reel"/
// "Premium Video"), set from the product map.
const REEL_VIDEO_TYPES = new Set(["SOCIAL_REEL", "VIDEO"]);
const PREMIUM_HOURS = 72;
const STANDARD_REEL_HOURS = 48;

// Add N business days (skip Sat/Sun) to a date.
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

type DueOpts = { monthlyContent?: boolean; premium?: boolean };

// Turnaround due for one deliverable from an anchor date.
export function deliveryDueFrom(anchor: Date, deliverableType?: string | null, opts: DueOpts = {}): Date {
  if (deliverableType && REEL_VIDEO_TYPES.has(deliverableType)) {
    if (opts.premium) return new Date(anchor.getTime() + PREMIUM_HOURS * HOUR); // premium wins over monthly
    if (opts.monthlyContent) return addBusinessDays(anchor, 10); // 7-10 business days
    return new Date(anchor.getTime() + STANDARD_REEL_HOURS * HOUR);
  }
  const h = (deliverableType && TURNAROUND_HOURS[deliverableType]) || 48;
  return new Date(anchor.getTime() + h * HOUR);
}

// MUST match projectStatus.ts PREMIUM_VIDEO_RE — the status card's videoDue and
// the delivery SLA written here have to agree (they previously diverged: this was
// /premium/ only, so an Influencer/Cinematic reel got a 48h SLA here but showed
// 72h on the status card — a 24h disagreement).
const isPremiumLabel = (label?: string | null) =>
  !!label && /premium|influencer|cinematic|luxury|signature|elite|flagship/i.test(label);

// A project's overall delivery due = shoot date + the LONGEST turnaround among
// its ordered deliverables (premium reel/video pushes it out, monthly further).
export function standardDeliveryDue(
  shootDate: Date,
  deliverables: { type: string; label?: string | null }[],
  monthlyContent = false,
): Date {
  if (deliverables.length === 0) return new Date(shootDate.getTime() + 48 * HOUR);
  return deliverables
    .map((d) => deliveryDueFrom(shootDate, d.type, { monthlyContent, premium: isPremiumLabel(d.label) }))
    .reduce((a, b) => (a > b ? a : b));
}

export type Priority = "URGENT" | "HIGH" | "MEDIUM" | "LOW";

// Derive priority from due date + shoot proximity + status.
export function computePriority(opts: {
  dueAt?: Date | null;
  shootDate?: Date | null;
  status?: string;
  now?: Date;
}): Priority {
  const now = opts.now ?? new Date();
  const startToday = new Date(now.toDateString()).getTime();
  if (opts.dueAt) {
    const diff = opts.dueAt.getTime() - now.getTime();
    if (diff < 0) return "URGENT"; // overdue
    if (diff < 4 * HOUR) return "URGENT";
    if (diff < DAY) return "HIGH";
  }
  if (opts.shootDate) {
    const days = Math.floor((opts.shootDate.getTime() - startToday) / DAY);
    if (days >= 0 && days <= 1) return "URGENT"; // shoot today/tomorrow
    if (days > 1 && days <= 3) return "HIGH"; // within 72h
  }
  return "MEDIUM";
}

function dedupe(parts: (string | null | undefined)[]): string {
  return crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);
}

// The real sender to store on a task, but ONLY when it's a different person than
// the account client it folds to (e.g. assistant "Olivia" on agent "Mike"'s
// account). Returns null when they're the same, so the card doesn't show a
// redundant name.
function differentName(contactName: string | null | undefined, clientName: string | null | undefined): string | null {
  const c = (contactName ?? "").trim();
  if (!c) return null;
  if (c.toLowerCase() === (clientName ?? "").trim().toLowerCase()) return null;
  return c.slice(0, 120);
}

type TaskSpec = {
  taskType: string;
  title: string;
  reasonCreated: string;
  checklist: ChecklistItem[];
  deliverableType?: string;
  dueAt?: Date | null;
  description?: string; // pre-drafted message (e.g. the confirmation text)
  summary?: string; // "what happened / what's needed" for the card
  assignedKey?: string; // editor this is delegated to (see src/lib/editors.ts)
};

// Friendly per-deliverable label for the consolidated QC checklist.
const QC_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Drone / aerial", TWILIGHT: "Twilight", HEADSHOT: "Headshots",
  VIRTUAL_STAGING: "Virtual staging", VIDEO: "Video", SOCIAL_REEL: "Reel",
  FLOORPLAN: "Floor plan", MATTERPORT_3D: "Matterport 3D", ZILLOW_3D: "Zillow 3D tour", OTHER: "Other",
};
const guide = (steps: string[]): ChecklistItem[] => steps.map((label) => ({ label, done: false }));

// Guided QC failure modes — the SPECIFIC things Kyle must actually eyeball before
// a category ships. These exist because QC was blind: his written guidance was one
// static sentence and the checklist had nothing to tick, so revisions ran ~13.7%
// and the sampled bounce-back reasons were EXACTLY the misses below (crooked
// verticals/perspective, item-removal left undone, reflections, sign/clutter). The
// vocabulary is keyed to IMAGE_FLAG_TAGS so a later auto-QA model trains on the
// same labels. Keyed by media CATEGORY (Photos / Video / Floor plan) — one block
// per category, appended to the checklist ONLY once that category is live on Aryeo
// (so we never ask Kyle to verify photos that haven't landed yet, and nothing gates
// prematurely). Labels are STABLE strings: the reconciler merge keys on label to
// preserve Kyle's manual ticks across syncs, so these must never change wording
// once shipped or a re-sync would drop the tick and silently re-open the gate.
const QC_FAILURE_MODES: Record<string, string[]> = {
  // Photos (covers PHOTOS / DRONE / TWILIGHT / HEADSHOT / VIRTUAL_STAGING — all
  // fold to the "Photos" category in TYPE_CATEGORY_LABEL and QC together).
  Photos: [
    "Verticals & horizontals straight (perspective)",
    "Blemishes / AI errors removed",
    "Colors & lighting consistent",
    "Clutter + our yard sign removed",
    "People / camera in mirrors & reflections gone",
    "Virtual staging / item removal done (if ordered)",
  ],
  // Video covers VIDEO + SOCIAL_REEL (both "Video" category).
  Video: [
    "Text on screen spelled right",
    "Music + branding correct",
  ],
  "Floor plan": [
    "Square footage matches the listing",
  ],
};

// The two extra passes we ask for on VIP / heavy clients — 38% of deliveries are
// VIP-segment (66% VIP+heavy) yet QC was client-blind. These are the two misses
// that most often bounce a high-value client. Prefixed "VIP —" so the card can
// render them as a distinct extra-pass section; they're real Kyle-ticks and gate
// auto-close like any other failure-mode item.
const VIP_EXTRA_PASS = [
  "VIP — Mirrors/reflections re-checked frame by frame",
  "VIP — Clutter sweep on every room",
] as const;
export const VIP_SEGMENTS = new Set(["vip", "heavy"]);

// Media category label for a deliverable type — mirrors CATEGORY_LABEL in
// projectStatus.ts (kept here to avoid a circular import). Lets us tell, from a
// project's status evidence (which lists present/missing by category label),
// whether a given ordered deliverable is already live on Aryeo.
const TYPE_CATEGORY_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Photos", TWILIGHT: "Photos", HEADSHOT: "Photos", VIRTUAL_STAGING: "Photos",
  VIDEO: "Video", SOCIAL_REEL: "Video",
  FLOORPLAN: "Floor plan",
  MATTERPORT_3D: "3D tour", ZILLOW_3D: "3D tour",
};

// Decide the expected tasks for one project, based on its pipeline stage.
function specsForProject(p: {
  status: string;
  title: string;
  shootDate: Date | null;
  deliverables: { type: string; label?: string | null }[];
  statusEvidence?: string | null;
  monthlyContent?: boolean;
  // Culling budget inputs — size the "gallery is over target, cull it" nudge on
  // the QC checklist (Kyle's manual read, doesn't gate auto-close).
  squareFeet?: number | null;
  photoTarget?: number | null;
  // Client segment (vip | heavy | …) — drives the VIP extra-pass ticks on the QC
  // checklist. QC used to be client-blind despite 38% of deliveries being VIP.
  clientSegment?: string | null;
}): TaskSpec[] {
  const specs: TaskSpec[] = [];
  const shoot = p.shootDate;
  const primary = p.deliverables[0]?.type ?? "PHOTOS";
  const monthly = !!p.monthlyContent;
  // Which deliverable types are premium (3-4 day reel/video) on this project.
  const premiumTypes = new Set(p.deliverables.filter((d) => isPremiumLabel(d.label)).map((d) => d.type));
  const dueOpts = (type: string) => ({ monthlyContent: monthly, premium: premiumTypes.has(type) });

  // What's already live on Aryeo (from the status cross-check). Used to retire
  // QA / "deliver gallery" work for a category the moment it's delivered — even
  // while the rest of the order (e.g. a reel) is still in production. Staged
  // delivery: photos go out next-day, the reel days later.
  const ev = parseEvidence(p.statusEvidence);
  const presentLabels = new Set(ev?.present ?? []);
  const isDelivered = (type: string) => {
    const lbl = TYPE_CATEGORY_LABEL[type];
    return !!lbl && presentLabels.has(lbl);
  };
  const galleryDelivered = presentLabels.has("Photos");

  // NOTE: there's no separate "finish delivery" leak task. Each still-pending
  // deliverable already gets its own per-item QA task below (due at that item's
  // turnaround, auto-closing when it goes live), and the project page's Status
  // card surfaces any partial / missing items — so a standalone catch-all task
  // was just duplicate, often-stale noise (e.g. "missing Video" on a reel that
  // was actually on track). Removed in favor of the per-deliverable tasks.

  // Only while the shoot is still ahead of us. Once the shoot day arrives (or
  // the job advances past SCHEDULED), the confirmation is moot — dropping the
  // spec lets the reconciler auto-close any open confirmation_text below, so it
  // never lingers or reads "overdue" forever.
  const shootUpcoming = !shoot || shoot.getTime() >= etDayStartUtc().getTime();
  if ((p.status === "BOOKED" || p.status === "SCHEDULED") && shootUpcoming) {
    specs.push({
      taskType: "confirmation_text",
      title: `Confirmation text — ${p.title}`,
      reasonCreated: "Day-before confirmation text (SOP)",
      summary: "Day before the shoot: review the drafted confirmation text and send it. Confirm access (someone meeting us or a lockbox + code), what to highlight/avoid, and offer an upgrade if it fits.",
      // No deliverableType: a confirmation is one-per-shoot, so its dedupe key must
      // stay stable. Keying it on the primary deliverable meant a re-synced order
      // whose deliverables reordered could mint a SECOND confirmation task.
      deliverableType: undefined,
      dueAt: shoot ? new Date(shoot.getTime() - DAY) : null,
      // description (the drafted text) is filled in at creation time, where the
      // client name + shoot time + photographer are available.
      checklist: guide([
        "Review the drafted confirmation text below",
        "Send it to the client via OpenPhone",
        "Confirm access — someone meeting us, or a lockbox? Get the code",
        "Note what to highlight / avoid + that the property will be ready",
        "Offer an upgrade if it fits — twilight, drone, staging, 3D, floor plan",
      ]),
    });
  }

  // REVISION included: the reopened QC card must keep receiving evidence
  // merges (re-ticked auto rows when the corrected media lands) instead of
  // freezing until a human resolves the revision.
  if (p.status === "SHOT" || p.status === "EDITING" || p.status === "REVIEW" || p.status === "REVISION") {
    const anchor = shoot ?? new Date();
    // ONE consolidated QC task per project: a checkbox per deliverable category,
    // pre-checked for anything already live on Aryeo. Replaces the old per-item
    // "QA <type>" tasks. Due at the SOONEST pending item's turnaround. Only the
    // pending (unchecked) items are work; if everything's live we skip it (and
    // the reconciler closes any existing one).
    const qcTypes = dedupeTypes(p.deliverables);
    // Build the checklist category-by-category: the auto-checked "QC <category>"
    // evidence row, then — ONLY once that category is live on Aryeo — the guided
    // failure-mode sub-items Kyle must actually verify. Appending sub-items only
    // when isDelivered(d) means a photos-not-yet-live job shows NO photo sub-items
    // yet, so nothing gates before the media exists; they appear the moment the
    // category lands and the reconciler's prevDone map preserves Kyle's ticks from
    // then on. Auto-check rows stay auto-checked; only the sub-items are his work.
    const isVip = !!p.clientSegment && VIP_SEGMENTS.has(p.clientSegment);
    const seenCategories = new Set<string>();
    const qcItems: ChecklistItem[] = [];
    for (const d of qcTypes) {
      const live = isDelivered(d);
      qcItems.push({ label: `QC ${QC_LABEL[d] ?? labelFor(d)}`, done: live });
      // Failure modes attach to the media CATEGORY, not the raw type, and only
      // once — a job with photos + drone (both "Photos") gets ONE photo block.
      const category = TYPE_CATEGORY_LABEL[d];
      if (live && category && !seenCategories.has(category)) {
        seenCategories.add(category);
        for (const label of QC_FAILURE_MODES[category] ?? []) qcItems.push({ label, done: false });
        // VIP extra pass rides on the Photos block (that's where reflections/
        // clutter misses live) — the two ticks that most often bounce a VIP.
        if (isVip && category === "Photos") for (const label of VIP_EXTRA_PASS) qcItems.push({ label, done: false });
      }
    }
    // QC and "deliver the gallery" are ONE motion for Kyle — a separate
    // "Deliver gallery" task open NEXT TO the QC task doubled every job's cards
    // (Jordan: "too many redundant QC tasks"; 47 of 65 recent jobs carried 2-4
    // check-type tasks). The deliver step is the QC card's LAST checklist item,
    // auto-checked when the gallery goes out — so the card lives QC → deliver →
    // done, and one job = one card. (The old delivery-spec keys fall out of
    // expectedKeys, so the reconciler retires existing open ones.)
    qcItems.push({
      label: monthly
        ? "Produce + deliver this month's content (Aryeo + branded email)"
        : "Deliver the gallery (Aryeo + branded email)",
      done: galleryDelivered,
    });
    // Cull-at-delivery guardrail (Jul 2026 audit): delivered count == final-folder
    // count in EVERY observed job — nobody culls, so 76% of galleries ship over 50.
    // When the live photo count already exceeds this home's budget, add ONE
    // guidance line so Kyle culls near-duplicates before delivering. It's a READ,
    // not a gate: pushed pre-checked (done: true) so it NEVER blocks the media_qa
    // auto-close (checklistComplete needs every item done). Mirrors how the
    // isDelivered() items ride the same checklist without becoming Kyle's work.
    const galleryPhotoCount = Math.max(ev?.aryeo?.photos ?? 0, ev?.dropbox?.finalPhotos ?? 0);
    const budget = photoTargetFor({ squareFeet: p.squareFeet, photoTarget: p.photoTarget });
    if (galleryPhotoCount > budget) {
      qcItems.push({
        label: `Gallery is ${galleryPhotoCount} photos vs ~${budget} target — cull near-duplicates before delivering (keep the best of each room).`,
        done: true,
      });
    }
    const pendingDues = qcTypes.filter((d) => !isDelivered(d)).map((d) => deliveryDueFrom(anchor, d, dueOpts(d)).getTime());
    if (qcTypes.length > 0 && qcItems.some((i) => !i.done)) {
      specs.push({
        taskType: "media_qa",
        title: `QC & deliver — ${p.title}`,
        reasonCreated: "Media in production — QC each deliverable, then deliver",
        summary: monthly
          ? "Monthly personal-branding / social content (7–10 business-day turnaround). QC each piece as it lands, then produce + deliver this month's content. Auto-completes once everything is live and delivered."
          : "Content is coming in for this shoot. Quality-check each deliverable as it lands on Aryeo (verticals + horizontals, no odd edits/reflections/blemishes, staging + item removal done), then deliver the gallery via Aryeo + the branded email. Auto-completes once every category is live and the gallery is out.",
        dueAt: pendingDues.length ? new Date(Math.min(...pendingDues)) : deliveryDueFrom(anchor, primary, dueOpts(primary)),
        checklist: qcItems,
      });
    }
  }

  return specs;
}

function dedupeTypes(deliverables: { type: string }[]): string[] {
  // Drone aerial photos are part of the photo set — QA them together, so a job
  // with photos + drone gets ONE "QA photos" task, not separate drone/photo QAs.
  const norm = (t: string) => (t === "DRONE" ? "PHOTOS" : t);
  return [...new Set(deliverables.map((d) => norm(d.type)))].slice(0, 4);
}
function labelFor(t: string) {
  return t.replace(/_/g, " ").toLowerCase();
}

// Create a "client reply / callback" task from an inbound communication, matched
// to a client (+ their latest project). One open reply task per client is kept
// (deduped) so a burst of texts doesn't spawn duplicates.
export async function createCommTask(opts: {
  clientId: string;
  clientName: string;
  // The real person who wrote in, when different from the account client (e.g. an
  // assistant emailing on the agent's behalf). Shown as the person on the card.
  contactName?: string | null;
  projectId?: string | null;
  propertyAddress?: string | null;
  kind: "text" | "missed_call" | "voicemail";
  snippet?: string;
  source?: string;
  // AI-derived, specific action ("Reschedule 320 Tarbert to Thursday").
  aiTitle?: string | null;
  aiDetail?: string | null;
  // Smart-Brain priority (context-aware). Defaults to HIGH.
  priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  // Provenance ref (e.g. "gmail-thread:hello@…:<threadId>") so the listener can
  // auto-close the task once we've replied in that thread.
  threadRef?: string | null;
}): Promise<boolean> {
  // One open reply task per (client, order) — a multi-order client's questions
  // stay separate, and replying about one order won't close another's.
  const key = dedupe([opts.clientId, opts.projectId ?? "noproject", "client_reply"]);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") return false;

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const verb = opts.kind === "text" ? "Reply to" : "Call back";
  const sourceName =
    opts.source === "gmail" ? "Gmail" : opts.source === "slack" ? "Slack" : "OpenPhone";
  const reason =
    opts.kind === "text"
      ? `Inbound message from client (${sourceName})`
      : opts.kind === "voicemail"
        ? "Voicemail from client (OpenPhone)"
        : "Missed call from client (OpenPhone)";
  // Replies due within a few hours; callbacks sooner.
  const dueAt = new Date(Date.now() + (opts.kind === "text" ? 4 : 1) * HOUR);

  // The client's name renders UNDER the title on every task card, so we keep it
  // out of the title itself (no redundant "(Client Name)" suffix). Fall back to a
  // clean generic when the brain didn't title it.
  const title = opts.aiTitle
    ? opts.aiTitle
    : opts.kind === "text"
      ? "Reply to the latest message"
      : opts.kind === "voicemail"
        ? "Return the voicemail"
        : "Return the missed call";
  // Keep the MESSAGE itself on the task (word-boundary clip, generous cap) —
  // "read the full context" shouldn't require leaving the card. aiDetail is NOT
  // prefixed here: it already IS the summary, and prefixing rendered the same
  // paragraph twice on the card and in the full view.
  const description = (opts.snippet ? clip(opts.snippet, 1200) : opts.aiDetail?.trim()) || null;
  // "What happened" summary for the card: the brain's read of the ask, else the
  // message itself.
  const summary =
    opts.aiDetail?.trim() ||
    (opts.snippet ? `${opts.clientName} ${opts.kind === "text" ? "wrote in" : "reached out"}: “${clip(opts.snippet, 240)}”` : `${verb} ${opts.clientName}.`);

  const data = {
    taskType: "client_reply",
    title: title.slice(0, 120),
    summary: summary.slice(0, 500),
    description,
    reasonCreated: reason,
    checklist: JSON.stringify([
      "Read the full conversation in Communications",
      "Match to the right order if multiple",
      "Reply / call back",
      "Log outcome",
    ]),
    source: opts.source ?? "openphone",
    sourceDetail: opts.threadRef ?? null,
    priority: opts.priority ?? "HIGH",
    dueAt,
    clientId: opts.clientId,
    contactName: differentName(opts.contactName, opts.clientName),
    projectId: opts.projectId ?? null,
    propertyAddress: opts.propertyAddress ?? null,
    ownerId: kyle?.id ?? null,
    dedupeKey: key,
  };

  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({ data });
  }
  // URGENT means "someone should know NOW" — ping Slack instead of waiting for
  // the next hub visit. Best-effort: never breaks task creation.
  if (data.priority === "URGENT") {
    try {
      const { notifyUrgent } = await import("@/lib/notify");
      await notifyUrgent(`URGENT — ${data.title}${opts.clientName ? ` (${opts.clientName})` : ""}`);
    } catch { /* non-fatal */ }
  }
  return true;
}

// File an instruction/follow-up task on a SPECIFIC project from an inbound text
// that named that property — even when the sender isn't the project's client
// (a photographer like Harrison, or a coordinator like Ruthie). Deduped to one
// open task per (project, sender) so a back-and-forth refreshes instead of piling up.
export async function createProjectFollowupTask(opts: {
  projectId: string;
  clientId?: string | null;
  propertyAddress?: string | null;
  senderName: string;
  text: string;
  source?: string;
  aiTitle?: string | null;
  aiDetail?: string | null;
  priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
}): Promise<boolean> {
  // Stable per (project, sender) — normalize the sender so name variants
  // ("Harrison" vs "Harrison Wells") don't spawn duplicate tasks.
  const senderKey = opts.senderName.toLowerCase().replace(/[^a-z]/g, "").slice(0, 16) || opts.senderName;
  const key = dedupe([opts.projectId, "comms_followup", senderKey]);
  // Always anchor the task to a client: derive it from the order when not given.
  let clientId = opts.clientId ?? null;
  if (!clientId) {
    const p = await prisma.project.findUnique({ where: { id: opts.projectId }, select: { clientId: true } });
    clientId = p?.clientId ?? null;
  }
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const street = (opts.propertyAddress ?? "this job").split(",")[0];
  const title = (opts.aiTitle || `${opts.senderName} re ${street}`).slice(0, 120);
  // Message only — aiDetail already lives in the summary (no double render).
  const description = clip(opts.text, 1200) || null;
  const summary =
    opts.aiDetail?.trim() || `${opts.senderName} messaged about ${street}: “${clip(opts.text, 240)}”`;
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  const data = {
    taskType: "comms_followup",
    title,
    summary: summary.slice(0, 500),
    description,
    reasonCreated: `${opts.senderName} texted about this job (${opts.source ?? "openphone"})`,
    checklist: JSON.stringify([
      "Read the full message in Communications",
      "Action the request on this job",
      "Reply / confirm with the sender",
      "Log the outcome",
    ]),
    source: opts.source ?? "openphone",
    priority: opts.priority ?? "HIGH",
    dueAt: new Date(Date.now() + 4 * HOUR),
    clientId,
    projectId: opts.projectId,
    propertyAddress: opts.propertyAddress ?? null,
    ownerId: kyle?.id ?? null,
    dedupeKey: key,
  };
  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({ data });
  }
  return true;
}

// Close a client's open "reply" task once we've responded. With per-order reply
// tasks, pass the projectId to close ONLY that order's reply task; omit it to
// close all of the client's open reply tasks (used when we can't tell which order
// a reply addressed).
export async function closeClientReplyTask(clientId: string, projectId?: string | null): Promise<boolean> {
  // Only the CLIENT's own reply ask. A comms_followup is a separate instruction
  // filed by a non-client teammate (a photographer's lockbox code, a coordinator's
  // note) — replying to the client does NOT mean that instruction was handled, so
  // it must never be auto-closed here or actionable work would silently vanish.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { clientId, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } };
  if (projectId) where.projectId = projectId;
  const r = await prisma.smartTask.updateMany({ where, data: { status: "COMPLETED", completedAt: new Date() } });
  return r.count > 0;
}

// Close the right reply task after WE send an outbound message, inferring which
// order it addressed: first from the text (a named street), then from the most
// recent inbound we logged for this client. Falls back to closing all the
// client's reply tasks only when the order genuinely can't be determined.
export async function closeReplyForOutbound(clientId: string, text: string): Promise<boolean> {
  let projectId: string | null = null;
  try {
    const { findClientProjectByText } = await import("@/lib/contacts");
    const named = await findClientProjectByText(clientId, text || "");
    if (named) projectId = named.id;
  } catch { /* fall through */ }
  if (!projectId) {
    const lastInbound = await prisma.commLog.findFirst({
      where: { clientId, direction: "in", projectId: { not: null } },
      orderBy: { occurredAt: "desc" },
      select: { projectId: true },
    });
    projectId = lastInbound?.projectId ?? null;
  }
  return closeReplyScoped(clientId, projectId);
}

// After an outbound CALL to the client (we returned their call), close the
// callback/reply task. No text to parse, so scope to the passed order when known,
// else close only when there's a single open reply task.
export async function closeReplyForOutboundCall(clientId: string, projectId?: string | null): Promise<boolean> {
  return closeReplyScoped(clientId, projectId ?? null);
}

// Close a client's reply task WITHOUT risking the wrong order's: if the order is
// known, close that one; if not, only blanket-close when the client has exactly
// ONE open reply task. Multi-order + unknown → leave it for a human, so a generic
// "thanks!" outbound can't silently clear an unrelated order's open question.
async function closeReplyScoped(clientId: string, projectId: string | null): Promise<boolean> {
  if (projectId) return closeClientReplyTask(clientId, projectId);
  const open = await prisma.smartTask.findMany({
    where: { clientId, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  if (open.length !== 1) return false;
  await prisma.smartTask.update({ where: { id: open[0].id }, data: { status: "COMPLETED", completedAt: new Date() } });
  return true;
}

// Merge a new inbound into an EXISTING open task the Smart Brain flagged as the
// same request — reopen it, refresh the title/priority/order, and append the new
// context instead of creating a duplicate.
export async function mergeIntoExistingTask(taskId: string, opts: {
  title?: string;
  detail?: string;
  priority?: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  projectId?: string | null;
  clientId?: string | null;
  propertyAddress?: string | null;
  snippet?: string;
  clientName?: string;
  contactName?: string | null;
}): Promise<boolean> {
  const existing = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { description: true, taskType: true } });
  if (!existing) return false;
  // Never merge an inbound comm into a production task (QC/delivery/confirmation/
  // delivery text) — that would overwrite its title/summary. Refuse so the caller
  // falls back to creating a proper reply task.
  if (["media_qa", "delivery", "confirmation_text", "delivery_text", "feedback_review", "image_fixes"].includes(existing.taskType)) return false;
  // The MESSAGE is the update; detail (the brain's read) refreshes the summary
  // below — repeating it in the description doubled the same paragraph.
  const addition = opts.snippet ? clip(opts.snippet, 800) : opts.detail ?? "";
  // Keep the LATEST updates when the log outgrows the cap — the newest message
  // is the one being acted on (the old head-slice silently ate new updates).
  let description = [existing.description, addition ? `Update: ${addition}` : null].filter(Boolean).join("\n\n");
  if (description.length > 4000) description = "…" + description.slice(-4000);
  const titled = opts.title ? opts.title.slice(0, 120) : undefined;
  // Refresh the "what happened" summary to the latest read when we have one.
  const summary = (opts.detail?.trim() || opts.snippet?.trim()) ? (opts.detail?.trim() || `New message: “${clip(opts.snippet!, 240)}”`) : undefined;
  await prisma.smartTask.update({
    where: { id: taskId },
    data: {
      status: "OPEN",
      completedAt: null,
      description,
      ...(summary ? { summary: summary.slice(0, 500) } : {}),
      ...(titled ? { title: titled } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
      ...(opts.propertyAddress !== undefined ? { propertyAddress: opts.propertyAddress } : {}),
      ...(opts.contactName !== undefined ? { contactName: differentName(opts.contactName, opts.clientName) } : {}),
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// QcRecord — the owner's quality dial. One row per QC pass, written when a
// media_qa card completes. It snapshots WHICH failure-mode items Kyle actually
// ticked (a miss = a Kyle-tick left false at completion) so we can see, over
// time, whether QC is being run or rubber-stamped, and — when a revision later
// reopens the QC — WHY it bounced. Read-only analytics; never gates task flow.
// ---------------------------------------------------------------------------

// Auto-checked evidence rows on a media_qa checklist are driven by Aryeo/gallery
// signals, NOT by Kyle: the per-category "QC <label>" rows, the "Deliver the
// gallery / Produce + deliver …" row, and the pre-checked "cull near-duplicates"
// guidance line. Everything else (the failure-mode sub-items, VIP passes, and any
// revision-injected re-QC item) is a MANUAL Kyle-tick — those are the ones a miss
// is counted against. Keep this in sync with the labels specsForProject emits.
function isAutoCheckRow(label: string): boolean {
  const l = label.trim();
  // Category evidence rows: "QC Photos", "QC Reel", "QC Floor plan", … BUT not a
  // revision-injected "QC <cat> (revision)" (that IS Kyle's manual re-QC work).
  if (/^QC\s/i.test(l) && !/\(revision\)/i.test(l)) return true;
  if (/deliver the gallery/i.test(l) || /produce \+ deliver/i.test(l)) return true;
  if (/cull near-duplicates/i.test(l)) return true;
  return false;
}

// How many Kyle-tick items were left unchecked at completion (the auto-check
// evidence rows don't count as misses — they're not his to verify).
export function countQcMisses(items: ChecklistItem[]): number {
  return items.filter((i) => !isAutoCheckRow(i.label) && !i.done).length;
}

// Write ONE QcRecord for a just-completed media_qa task, idempotently. Called
// from BOTH completion paths (the reconciler's auto-complete branch and the
// interactive toggle action) — dedupe on "a QcRecord for this project completed
// in the last few minutes" so re-running the reconciler right after a completion
// never double-writes. Best-effort: a QcRecord failure must never break the task
// flow, so callers wrap this and swallow.
const QC_RECORD_DEDUPE_MS = 5 * 60_000;
export async function recordQcCompletion(opts: {
  projectId: string;
  items: ChecklistItem[];
  clientSegment?: string | null;
  completedBy?: string | null;
}): Promise<void> {
  const recent = await prisma.qcRecord.findFirst({
    where: { projectId: opts.projectId, completedAt: { gte: new Date(Date.now() - QC_RECORD_DEDUPE_MS) } },
    select: { id: true },
  });
  if (recent) return; // already logged this completion (both paths fired)
  await prisma.qcRecord.create({
    data: {
      projectId: opts.projectId,
      clientSegment: opts.clientSegment ?? null,
      itemsChecked: serializeChecklist(opts.items),
      missCount: countQcMisses(opts.items),
      completedBy: opts.completedBy ?? null,
    },
  });
}

// When a deliverable goes back into revision (e.g. Luma "Revision Request
// Received" on a reel), reflect it in the project's QC task: reopen it and mark
// the revised deliverable's checkbox as needing a re-QC (unchecked). Creates the
// QC task if the job had already been delivered + its QC completed.
// `categories` = QC labels like ["Reel"] / ["Photos"]; empty = generic re-QC.
// `reason` = the revision summary; when present we stamp the project's latest
// QcRecord with reopenedByRevisionAt + revisionReason — that bounce IS the QC-miss
// event, and it's what the owner dial reads to compute the real miss rate.
export async function reflectRevisionInQc(projectId: string, categories: string[], reason?: string | null): Promise<void> {
  // Stamp the latest QC pass as reopened-by-revision (best-effort, before the
  // reopen below re-opens the task). If QC never ran (no record) this no-ops.
  try {
    const last = await prisma.qcRecord.findFirst({
      where: { projectId },
      orderBy: { completedAt: "desc" },
      select: { id: true },
    });
    if (last) {
      await prisma.qcRecord.update({
        where: { id: last.id },
        data: { reopenedByRevisionAt: new Date(), revisionReason: reason?.slice(0, 500) ?? null },
      });
    }
  } catch { /* dial is analytics-only — never block the revision */ }
  const existing = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "media_qa" },
    orderBy: { createdAt: "desc" },
  });

  const markRevised = (items: ChecklistItem[]): ChecklistItem[] => {
    const out = [...items];
    if (categories.length === 0) {
      // A SECOND generic revision must re-arm the gate: the row from round one
      // is already ticked done, and leaving it done meant the reconciler saw
      // an all-done card and auto-completed the re-QC within the hour.
      const idx = out.findIndex((i) => /re-?qc after revision/i.test(i.label));
      if (idx >= 0) out[idx] = { label: out[idx].label, done: false };
      else out.push({ label: "Re-QC after revision", done: false });
      return out;
    }
    for (const c of categories) {
      const idx = out.findIndex((i) => i.label.toLowerCase().includes(c.toLowerCase()));
      if (idx >= 0) out[idx] = { label: out[idx].label.includes("(revision)") ? out[idx].label : `${out[idx].label} (revision)`, done: false };
      else out.push({ label: `QC ${c} (revision)`, done: false });
    }
    return out;
  };

  if (existing) {
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: {
        status: "OPEN",
        completedAt: null,
        priority: "HIGH",
        dueAt: new Date(),
        checklist: serializeChecklist(markRevised(parseChecklist(existing.checklist))),
      },
    });
    return;
  }

  // No QC task (job was delivered + QC closed) → make one for the re-QC.
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, clientId: true } });
  if (!project) return;
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "media_qa",
      title: `QC — ${project.title}`,
      summary: "A deliverable went back into revision after delivery. Re-QC the corrected version once it's re-uploaded, then re-deliver to the client.",
      reasonCreated: "Deliverable back in revision — re-QC the new version",
      checklist: serializeChecklist(markRevised([])),
      source: "revision",
      priority: "HIGH",
      dueAt: new Date(),
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: dedupe([projectId, "media_qa"]),
    },
  });
}

// Production tasks that become obsolete once a job is delivered/cancelled.
const PRODUCTION_TASK_TYPES = ["confirmation_text", "appointment_prep", "media_qa", "delivery", "finish_delivery"];
// On DELIVERED we ALSO retire a couple of non-"production" types that are moot
// once the gallery shipped: outstanding photo-flag fixes (a real re-do comes back
// as a client revision, which is left open) and teammate job-prep instructions.
// NOT delivery_text — that's created below and closes on its own timer/send.
// vendor_update ("download + QC the finished Luma reel") is delivery work by
// definition — once the job is DELIVERED it happened; nothing else closes it
// (audit: no close path, tasks rotted open forever).
const DELIVERED_CLOSE_TYPES = [...PRODUCTION_TASK_TYPES, "image_fixes", "comms_followup", "edit_video", "vendor_update"];

// Close out a project's now-obsolete open tasks when it reaches a terminal
// state, so Daily Tasks doesn't show ghost work on finished/cancelled jobs.
//   DELIVERED  → complete the production tasks (QA/deliver/prep/finish)
//   CANCELLED  → cancel every open task on the job
// Comm-driven tasks (client_reply / revision) are left alone — still actionable.
export async function closeObsoleteTasks(projectId: string, projectStatus: string): Promise<number> {
  if (projectStatus === "CANCELLED") {
    const r = await prisma.smartTask.updateMany({
      where: { projectId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "CANCELLED" },
    });
    return r.count;
  }
  if (projectStatus === "DELIVERED") {
    // Kyle delivers on Aryeo directly, so this sweep — not the guided checklist
    // — is how most media_qa cards actually die. Snapshot each one into a
    // QcRecord FIRST (missCount = whatever was still unticked, completedBy
    // "auto:delivered") so a bypassed QC pass is measurable instead of
    // invisible: 30 of 30 deliveries had closed this way with ZERO QcRecords,
    // and the owner's quality dial read empty (July 2026 audit). Analytics
    // only — a record failure never blocks the close.
    try {
      const qcCards = await prisma.smartTask.findMany({
        where: { projectId, taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: { checklist: true },
      });
      if (qcCards.length > 0) {
        const segment = await prisma.project.findUnique({
          where: { id: projectId },
          select: { client: { select: { segment: true } } },
        });
        for (const card of qcCards) {
          await recordQcCompletion({
            projectId,
            items: parseChecklist(card.checklist),
            clientSegment: segment?.client?.segment ?? null,
            completedBy: "auto:delivered",
          });
        }
      }
    } catch { /* QC snapshot is best-effort */ }
    const r = await prisma.smartTask.updateMany({
      where: {
        projectId,
        taskType: { in: DELIVERED_CLOSE_TYPES },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    // The cull nudge (taskType "todo", dedupeKey cull-<id>) is moot once the
    // gallery shipped — the raws can't be thinned retroactively. Close it so it
    // doesn't rot as noise (todo-type tasks are swept by nothing else).
    await prisma.smartTask.updateMany({
      where: { projectId, dedupeKey: `cull-${projectId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    // Closing the image_fixes task without resolving its ImageFlag rows left
    // the Flags tab lying ("3 open flags" on a delivered gallery) — and ONE new
    // flag resurrected every stale one into Kyle's 24h fix task (audit). The
    // delivery IS the resolution: fixed or shipped-as-is, the round is over.
    await prisma.imageFlag
      .updateMany({
        where: { projectId, status: "OPEN" },
        data: { status: "FIXED", resolvedAt: new Date() },
      })
      .catch(() => {});
    await createDeliveryTextTask(projectId);
    return r.count;
  }
  return 0;
}

// When a job is delivered, queue Kyle's post-delivery client TEXT (we dropped
// care calls — no one answers). The drafted, status-aware message + feedback
// link is attached so Kyle just reviews and sends. Deduped one per project.
export async function createDeliveryTextTask(projectId: string): Promise<void> {
  const key = dedupe([projectId, "delivery_text"]);
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, clientId: true, statusEvidence: true, client: { select: { name: true } } },
  });
  if (!project) return;
  const { deliveryMessage } = await import("@/lib/delivery");
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "delivery_text",
      title: `Send delivery text — ${project.title}`,
      summary: "This job was delivered. Review the drafted post-delivery text (with the feedback link) and send it to the client. A feedback reply auto-logs back to the project.",
      description: deliveryMessage(project),
      reasonCreated: "Delivered — send the post-delivery client text + feedback link",
      checklist: JSON.stringify([
        "Review the drafted message below",
        "Send it to the client via OpenPhone",
        "Watch for a feedback reply (auto-logs to the project)",
      ]),
      source: "system",
      priority: "MEDIUM",
      dueAt: new Date(),
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: key,
    },
  });
}

// A delivery text is a courtesy "your gallery is ready" nudge. If it's still open
// a week after it was queued, Kyle already sent it (often straight from his phone,
// bypassing the in-app Send button that closes it) or it's simply moot — the
// client got the gallery via Aryeo's delivery email regardless. Close it so it
// stops reading "overdue" forever and inflating the queue's overdue count.
export async function closeStaleDeliveryTexts(days = 7): Promise<number> {
  const cutoff = new Date(Date.now() - days * DAY);
  const r = await prisma.smartTask.updateMany({
    where: { taskType: "delivery_text", status: { notIn: ["COMPLETED", "CANCELLED"] }, createdAt: { lt: cutoff } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return r.count;
}

// Positive/neutral feedback mints a "review client feedback" task that nothing
// ever closes (feedback_review is in no auto-close list — audit crack #35). A
// week on, a "thanks, loved it!" needs no follow-up: close the non-urgent ones.
// NEGATIVE feedback tasks are URGENT and stay open until a human resolves them.
export async function closeStaleFeedbackReviews(days = 7): Promise<number> {
  const cutoff = new Date(Date.now() - days * DAY);
  const r = await prisma.smartTask.updateMany({
    where: {
      taskType: "feedback_review",
      priority: { not: "URGENT" },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      createdAt: { lt: cutoff },
    },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return r.count;
}

// ---------------------------------------------------------------------------
// Vendor round-trip chase (audit crack #16). CubiCasa (floor plans) and AutoHDR
// (photo edits) are fire-and-forget vendors: their "it's ready" emails are
// filtered as noise, so when their piece never comes back the only tracker is
// Kyle's memory — 14 of 141 recent deliveries shipped missing a whole ordered
// category. When the status cross-check shows one of their categories STILL
// missing days after the shoot, mint ONE deduped chase task per
// project+category (never re-minted once handled, even if completed).
// ---------------------------------------------------------------------------
const VENDOR_CHASE: { category: string; vendor: string; work: string; delayDays: number }[] = [
  // Floor-plan turnaround is 36h; photos are next-morning. Chasing a day+ past
  // those SLAs keeps this conservative — no task while the vendor is on time.
  { category: "Floor plan", vendor: "CubiCasa", work: "floor plan", delayDays: 3 },
  { category: "Photos", vendor: "AutoHDR", work: "photo edits", delayDays: 2 },
];

export async function chaseVendorsForMissing(
  projectId: string,
  opts: { title: string; shootDate: Date | null; missing: string[] },
): Promise<number> {
  if (!opts.shootDate || opts.missing.length === 0) return 0;
  const daysSinceShoot = (Date.now() - opts.shootDate.getTime()) / DAY;
  const due = VENDOR_CHASE.filter(
    (v) => opts.missing.includes(v.category) && daysSinceShoot >= v.delayDays,
  );
  if (due.length === 0) return 0;

  const street = (opts.title || "this job").split(",")[0].trim();
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });

  let created = 0;
  for (const v of due) {
    // One chase per project+category, ever — a completed chase means Kyle
    // already handled it; don't nag again on the next hourly pass.
    const key = `vendor-chase-${projectId}-${v.category.toLowerCase().replace(/\s+/g, "")}`;
    if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) continue;
    await prisma.smartTask.create({
      data: {
        taskType: "comms_followup",
        title: `Chase ${v.vendor} ${v.work} — ${street}`.slice(0, 120),
        summary: `The ordered ${v.category.toLowerCase()} still isn't live on Aryeo ${Math.floor(daysSinceShoot)} days after the shoot — the ${v.vendor} round-trip may have dropped. Check the ${v.vendor} portal/email for the finished ${v.work}, upload it, or chase them for an ETA.`.slice(0, 500),
        reasonCreated: `Ordered ${v.category.toLowerCase()} missing ${v.delayDays}+ days after the shoot (${v.vendor} round-trip)`,
        checklist: JSON.stringify([
          `Check ${v.vendor} for the finished ${v.work}`,
          "Upload it to Aryeo (or confirm it was delivered off-Aryeo)",
          `Chase ${v.vendor} for an ETA if it's not ready`,
        ]),
        source: "system",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 4 * HOUR),
        projectId,
        clientId: project?.clientId ?? null,
        propertyAddress: opts.title,
        ownerId: kyle?.id ?? null,
        dedupeKey: key,
      },
    });
    created++;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Cull-at-the-source (Jul 2026 audit). The hourly status sweep is the only place
// that reads the RAW folder count, so it's where "the photographer shot too much"
// gets caught. When raws blow past the photo budget × the overage factor, mint
// ONE deduped task pointing at the photographer so the pile gets culled BEFORE it
// costs editing money — and text them, since they've left the property. Called
// from syncProjectStatuses on SHOT/EDITING jobs only (raws in, not yet delivered).
// Best-effort by design: the caller never lets it break the sweep.
// ---------------------------------------------------------------------------
export async function mintCullTask(opts: {
  projectId: string;
  title: string;
  rawPhotos: number;
  target: number;
  photographerId: string | null;
  photographerName: string | null;
}): Promise<boolean> {
  const { projectId, rawPhotos, target } = opts;
  const street = (opts.title || "this job").split(",")[0].trim();
  const estFinals = Math.round(rawPhotos / BRACKET_RATIO);
  const overBy = rawPhotos - target * BRACKET_RATIO;
  // One cull task per project, ever — a completed one means the photographer
  // already handled it; don't re-nag on the next hourly pass (mirrors the
  // vendor-chase dedupe). "todo" type so no reconciler/auto-close sweep fights it.
  const key = `cull-${projectId}`;
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return false;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { clientId: true, addressLine: true },
  });
  // Route to the photographer by their first-name slug (same convention as every
  // other photographer-owned task); if we can't resolve one, leave it null so it
  // lands in triage rather than on the wrong person.
  const assignedKey = opts.photographerName ? slugForName(opts.photographerName) : null;

  await prisma.smartTask.create({
    data: {
      taskType: "todo",
      title: `Cull before edit — ${street}: ${rawPhotos} JPGs ≈ ${estFinals} finals vs ~${target} target`.slice(0, 120),
      summary: `This shoot uploaded ${rawPhotos} bracketed JPGs — roughly ${estFinals} finals once AutoHDR blends each ${BRACKET_RATIO}-exposure set, against a ~${target}-photo budget for this home (${overBy > 0 ? `~${overBy} JPGs over` : "over budget"}). Cull the raw folder before it goes to editing: keep the best ONE ${BRACKET_RATIO}-bracket set per room/composition and drop the near-duplicates. Culling here saves editing money and gives the client a tighter gallery.`.slice(0, 500),
      reasonCreated: `Raw upload (${rawPhotos} JPGs) far exceeds the ~${target}-photo budget (× ${BRACKET_RATIO}-bracket ratio) — over-shot`,
      checklist: JSON.stringify([
        "Open the 01-RAW-Photos folder for this shoot",
        `Keep the best single ${BRACKET_RATIO}-bracket set per room / composition`,
        "Delete the near-duplicate sets and machine-gunned extras",
        `Aim to land near ~${target} finals (~${target * BRACKET_RATIO} JPGs at ${BRACKET_RATIO} brackets each)`,
      ]),
      source: "system",
      priority: "HIGH",
      dueAt: new Date(Date.now() + 4 * HOUR),
      projectId,
      clientId: project?.clientId ?? null,
      propertyAddress: opts.title,
      assignedKey,
      dedupeKey: key,
    },
  });

  // Text the photographer — they've left the property, so the bell alone won't
  // reach them. Best-effort; the bridge no-ops if OpenPhone/phone is missing.
  if (opts.photographerId) {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "cull",
        // SMS = this title + a link, so the bracket math rides along: the
        // photographer sees files ≈ finals vs target, not a bare file count.
        title: `Cull before edit — ${street}: ${rawPhotos} JPGs ≈ ${estFinals} finals vs ~${target} target`.slice(0, 90),
        href: `/upload/${projectId}`,
        targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${opts.photographerId}`, href: `/upload/${projectId}` }],
        dedupeKey: `cull-notify-${projectId}`,
      });
    } catch { /* SMS/bell is best-effort */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Push handoff when a shoot's raws land (audit crack #19). Flipping to SHOT
// notified no one — the editor queue is pull-only — and a premium reel had no
// "send raws + brief to Luma" task anywhere, so a forgotten dispatch surfaced
// only as an overdue video days later. Called from the upload portal's
// finalize + the Dropbox raw-detection sweep, on the actual transition only.
// Idempotent: the Slack ping is keyed off a timeline marker, the Luma dispatch
// task off its dedupe key. Best-effort by design — callers never let it throw.
// ---------------------------------------------------------------------------
export async function notifyRawsLanded(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      client: { select: { socialClient: true } },
      deliverables: { select: { type: true, label: true } },
    },
  });
  if (!p) return;
  const street = (p.title || "this job").split(",")[0].trim();

  // Ping ops once per project — if either path (portal finalize / Dropbox sweep)
  // already announced it, don't re-ping.
  const MARKER = `Raws in for ${street}`;
  const already = await prisma.activity.findFirst({
    where: { projectId, type: "SYSTEM", body: { startsWith: MARKER } },
    select: { id: true },
  });
  if (!already) {
    // Marker row FIRST (crash-safe idempotence: a re-run after a mid-flight
    // crash must not re-ping) with neutral wording; the concrete outcome is
    // stamped on after we know what channelForEditor actually did — the old
    // hard-coded "notified via Slack" claimed delivery that often never
    // happened (John has no Slack/phone yet; audit #33 honesty residue).
    const marker = await prisma.activity.create({
      data: { projectId, type: "SYSTEM", body: `${MARKER} — announced to the editor bench.` },
    });
    try {
      const { notifyUrgent, notifyInApp } = await import("@/lib/notify");
      const { editorForDeliverable, editorMeta } = await import("@/lib/editors");
      await notifyUrgent(`Raws in for ${street} — ready for editing`, "/editing");
      // Bell mirror: ops + the whole editor bench (raws are pull-work — whoever
      // it routes to sees it in /editing either way) + a PERSON-ADDRESSED row for
      // the routed video editor (editor:<key>) so the notify bridge can DM/text
      // them in Manila. Photos-only jobs route to Kyle (not a bench editor) — the
      // editor:key row is only added for a real video route (kim/john/luma).
      const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
      const targets: import("@/lib/notify").NotifyTarget[] = [{ roles: ["ADMIN"] }, { roles: ["EDITOR"] }];
      let routedKey: string | null = null;
      if (v) {
        const key = editorForDeliverable(v.type, v.label, isMonthlyContentJob(p.deliverables));
        // Only in-house editors have a reachable channel; Luma (external) has no
        // bell/DM — its dispatch is the Kyle task below.
        if (key === "kim" || key === "john") {
          routedKey = key;
          // Their brief — the one page the EDITOR role can act from.
          targets.push({ roles: ["EDITOR"], userKey: `editor:${key}`, href: `/edit/${projectId}` });
        }
      }
      const { bridged } = await notifyInApp({
        kind: "raws_landed",
        title: `Raws in — ${street}`,
        href: "/editing",
        targets,
        dedupeKey: `raws-${projectId}`,
      });
      // Stamp the truth onto the timeline row.
      let outcome = "— posted to the editor bench (bell) + ops Slack.";
      if (routedKey) {
        const name = editorMeta(routedKey)?.name ?? routedKey;
        const channel = bridged.find((b) => b.userKey === `editor:${routedKey}`)?.channel ?? "none";
        outcome =
          channel === "slack" ? `— ${name} pinged by Slack DM.`
          : channel === "sms" ? `— ${name} texted (SMS).`
          : channel === "relay" ? `— ${name} has no Slack/phone on file; relayed to ops Slack to pass along by hand.`
          : channel === "quiet" ? `— bell posted for ${name}; ping held for their overnight quiet hours.`
          : `— bell posted for ${name}; no direct ping went out.`;
      }
      await prisma.activity.update({ where: { id: marker.id }, data: { body: `${MARKER} ${outcome}` } }).catch(() => {});
    } catch { /* never let a ping break the upload flow */ }
  }

  // Premium reel → the raws + brief go OUT to Luma, and nothing tracked that
  // dispatch. One deduped task, Kyle-owned (vendor named in the title — vendor
  // keys route to no human), auto-closed when the job delivers (comms_followup
  // is in DELIVERED_CLOSE_TYPES).
  const { videoTier } = await import("@/lib/projectStatus");
  if (videoTier(p.deliverables) !== "premium") return;
  const key = `luma-dispatch-${projectId}`;
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return;
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "comms_followup",
      title: `Send raws + brief to Luma — ${street}`.slice(0, 120),
      summary: "This job has a premium reel and the raws just landed — send the raw video + editor brief to Luma (ReadyPost) so the edit starts now instead of when the video goes overdue.",
      reasonCreated: "Premium reel raws landed — dispatch to Luma",
      checklist: JSON.stringify([
        "Send the raw video + editor brief to Luma",
        "Confirm Luma received it and note the ETA",
      ]),
      source: "system",
      priority: "HIGH",
      dueAt: new Date(Date.now() + 4 * HOUR),
      projectId,
      clientId: p.clientId,
      propertyAddress: p.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: key,
    },
  });
}

// ---------------------------------------------------------------------------
// Editor-addressed work just landed on a bell that NO login can see (no
// AppUser carries this editorKey) — nudge Jordan once to send that editor
// their invite. Called from the notify bridge on every new editor: row;
// deduped hard: the dedupeKey row (open OR completed) permanently blocks
// re-creation, so once Jordan completes it the nudge never comes back —
// and once the login exists the AppUser check short-circuits first.
// Best-effort: a nudge failure must never break the bell that triggered it.
// ---------------------------------------------------------------------------
export async function ensureEditorLoginNudge(editorKey: string): Promise<void> {
  try {
    const { TEAM_MEMBER_EDITOR_KEYS, editorMeta } = await import("@/lib/editors");
    if (!(TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(editorKey)) return; // vendors have no login
    const hasLogin = await prisma.appUser.count({ where: { editorKey, status: { not: "DISABLED" } } });
    if (hasLogin > 0) return;
    const key = `editor-login-${editorKey}`;
    if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return;
    const name = editorMeta(editorKey)?.name ?? editorKey;
    await prisma.smartTask.create({
      data: {
        taskType: "todo",
        title: `Send ${name} their Hub login — need their email`.slice(0, 120),
        summary:
          `Work keeps getting pinged to ${name}'s bell, but no Hub login exists for editor key "${editorKey}" — everything addressed to them is invisible in-app (they're reached only by Slack/SMS/ops relay for now). ` +
          `Invite them on /users with role EDITOR and first name "${name}" so their editor key wires up automatically` +
          (editorKey === "john" ? ", and add John Mark's phone to his Team row so texts can reach him too." : "."),
        reasonCreated: "Editor-addressed notification landed with no editor login to see it",
        source: "system",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 24 * HOUR),
        assignedKey: "jordan",
        dedupeKey: key,
      },
    });
  } catch { /* nudge is best-effort */ }
}

// ---------------------------------------------------------------------------
// The editor's WORK ITEM for a video job. `notifyRawsLanded` pings the bench;
// THIS mints the accountable task that lands in the routed editor's "Do now"
// list on /editing — the one thing that was missing while 4-of-8 videos ran
// overdue with nobody's name on them. VIDEO-ONLY: photos are AutoHDR'd on
// upload (no human), so a photos-only job mints nothing here. Deduped
// `edit-video-<projectId>`; auto-closed by the reconciler when the final video
// lands (see syncOneProjectTasks). Best-effort — callers wrap in try/catch.
//
// dueAt = the video's delivery-due MINUS a 12h QC buffer: the edit has to be in
// the door early enough for Kyle to QC + the client to see it before the SLA
// clock (shootDate + VIDEO SLA) actually expires. If the buffer would put the
// due date in the past (an already-late job), we don't backdate below "now +
// nudge" — an overdue edit is URGENT either way and a wildly-past date just
// reads as noise.
// ---------------------------------------------------------------------------
export async function mintEditTask(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      shootDate: true,
      addressLine: true,
      createdAt: true,
      frameioViewUrl: true,
      client: { select: { name: true, socialClient: true } },
      deliverables: { select: { type: true, label: true } },
    },
  });
  if (!p) return;
  // Only video/reel jobs get an editor task — photos are automated.
  const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  if (!v) return;

  const { videoTier } = await import("@/lib/projectStatus");
  const { editorForDeliverable, editorMeta } = await import("@/lib/editors");
  const { dropboxWebUrl, projectFolderPaths } = await import("@/lib/dropboxFolders");

  const monthly = isMonthlyContentJob(p.deliverables);
  const tier = videoTier(p.deliverables); // standard | premium | null
  const isPremium = tier === "premium";
  // null = personal branding: deliberately unrouted (Jordan assigns by hand);
  // edit_video is in TRIAGE_TYPES so the unassigned task sits in "Needs assigning".
  const assignedKey = editorForDeliverable(v.type, v.label, monthly); // "john" | null (+kyle/cubicasa for non-video)
  const editorName = assignedKey ? editorMeta(assignedKey)?.name ?? assignedKey : "manual assignment";
  const street = (p.title || "this job").split(",")[0].trim();

  // Video delivery-due = shootDate + the SAME SLA the status card uses, then a
  // 12h QC buffer pulls the EDIT due earlier. No shootDate → no computable SLA,
  // fall back to a short nudge window so the task still surfaces.
  const videoDue = p.shootDate
    ? deliveryDueFrom(p.shootDate, v.type, { premium: isPremium, monthlyContent: monthly })
    : null;
  const rawDue = videoDue ? new Date(videoDue.getTime() - 12 * HOUR) : new Date(Date.now() + 4 * HOUR);
  // Never surface a wildly-backdated due; clamp an already-late edit to "soon".
  const dueAt = rawDue.getTime() < Date.now() ? new Date(Date.now() + HOUR) : rawDue;

  const rawUrl = dropboxWebUrl(projectFolderPaths(p).rawVideo);
  const briefUrl = `/edit/${projectId}`;
  const tierLabel = isPremium ? "Premium" : "Standard";
  const dueLabel = videoDue
    ? videoDue.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "soon";

  const summary =
    `${tierLabel} reel for ${street}. Raws are in — cut the video. Delivery due ${dueLabel} (edit due 12h earlier for QC). ` +
    `RAW footage: ${rawUrl} · Brief: ${briefUrl}` +
    (p.frameioViewUrl ? ` · Frame.io: ${p.frameioViewUrl}` : "");

  const key = `edit-video-${projectId}`;
  const priority = computePriority({ dueAt, status: "SHOT" });
  // Upsert so a re-detected SHOT keeps ONE task and refreshes its route/due,
  // but a COMPLETED one is never resurrected (the reconciler owns re-open).
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing) {
    if (existing.status === "COMPLETED" || existing.status === "CANCELLED") return;
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: {
        // A human's editor choice (reassign / manual queue-add) outlives every
        // automatic refresh — only route when nobody picked by hand. And the
        // auto-router may IMPROVE a route but never STRIP one: a null route
        // (personal branding) must not un-assign work someone already owns.
        ...(existing.assignedManually || !assignedKey ? {} : { assignedKey }),
        dueAt,
        priority,
        summary: summary.slice(0, 500),
      },
    });
    return;
  }
  await prisma.smartTask.create({
    data: {
      taskType: "edit_video",
      title: `Edit — ${street}`.slice(0, 120),
      summary: summary.slice(0, 500),
      reasonCreated: assignedKey
        ? `Raws landed — ${tierLabel} reel routed to ${editorName}`
        : `Raws landed — personal-branding reel, needs an editor assigned`,
      checklist: JSON.stringify([
        "Open the RAW video folder",
        "Read the brief (reel recipe, editing notes, brand)",
        "Cut the video to the brief",
        "Drop the finished cut in 05-Final-Video",
        "Hit “Done — send to review” on your queue",
      ]),
      source: "system",
      priority,
      dueAt,
      assignedKey,
      projectId,
      clientId: p.clientId,
      propertyAddress: p.title,
      dedupeKey: key,
    },
  });
}

// ---------------------------------------------------------------------------
// ENSURE the editor handoff — idempotent, stage-independent, called by the
// hourly sweep for EVERY job in SHOT/EDITING/REVIEW (and by the photographer
// "done" buttons). Replaces the old transition-only wiring that had two fatal
// holes (July 2026 audit): jobs that skip SHOT (photos deliver fast →
// SCHEDULED→REVIEW) never got an editor task, and button-flipped SHOT never
// re-transitioned so the handoff was skipped. Everything inside is deduped
// (activity marker / dedupeKeys), so hourly re-calls are safe.
//   1. raws in            → notifyRawsLanded (bench ping + Luma dispatch, once)
//   2. video job          → persist Project.editorId for the tracker/reassign
//   3. cut submitted/live → clear any raw-video nudge, done
//   4. raw video missing  → ONE "find the raw video" task (folder mismatch or
//                           forgotten card — either way a human must look)
//   5. otherwise          → mint the edit_video work item; resurrect one that
//                           was falsely auto-completed with no cut anywhere
// ---------------------------------------------------------------------------
export async function ensureEditorHandoff(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      status: true,
      statusEvidence: true,
      editorId: true,
      photographerId: true,
      photographer: { select: { name: true } },
      client: { select: { socialClient: true } },
      deliverables: { select: { type: true, label: true } },
    },
  });
  if (!p) return;

  let ev: { present?: string[]; dropbox?: { rawPhotos?: number; rawVideo?: number; finalVideo?: number } | null } = {};
  try {
    ev = p.statusEvidence ? JSON.parse(p.statusEvidence) : {};
  } catch { /* unreadable evidence → treat as unknown */ }
  const dropbox = ev.dropbox ?? null;
  const anyRaw = !!dropbox && (dropbox.rawPhotos ?? 0) + (dropbox.rawVideo ?? 0) > 0;

  // 1. Announce the raws once (marker-idempotent inside notifyRawsLanded).
  if (anyRaw) await notifyRawsLanded(projectId);

  const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  if (!v) return; // photos-only → AutoHDR, no human editor

  // A human hand-picked this job's editor (owner reassign / manual queue-add):
  // don't overwrite their routing, and don't chase raw video — the owner just
  // looked at the job (old footage / externally-held files are expected there).
  const manualTask = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "edit_video", assignedManually: true, status: { notIn: ["CANCELLED"] } },
    select: { id: true },
  });

  // 2. Persist the routed editor for the tracker + one-click reassign (in-house only).
  if (!manualTask) {
    try {
      const { editorForDeliverable, editorTeamMemberId } = await import("@/lib/editors");
      const key = editorForDeliverable(v.type, v.label, isMonthlyContentJob(p.deliverables));
      const tmId = await editorTeamMemberId(key);
      if (tmId && p.editorId !== tmId) {
        await prisma.project.update({ where: { id: projectId }, data: { editorId: tmId } });
      }
    } catch { /* editor link is best-effort */ }
  }

  const NUDGE_KEY = `raw-video-missing-${projectId}`;
  const clearNudge = () =>
    prisma.smartTask.updateMany({
      where: { dedupeKey: NUDGE_KEY, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

  // 3. The cut is already in the owner's hands (Review Room submission) or
  // verifiably live (Aryeo/final folder) → nothing to mint; clear stale nudges.
  const submitted = await prisma.reviewSubmission.count({ where: { projectId } });
  const videoPresent = (ev.present ?? []).includes("Video") || (dropbox?.finalVideo ?? 0) > 0;
  if (submitted > 0 || videoPresent) {
    await clearNudge();
    return;
  }

  // 4. Raw video KNOWN missing (folders readable, zero video files) — the edit
  // can't start. Either the photographer forgot the video card or the files
  // live in a differently-named folder the hub can't see. ONE deduped task so
  // a human finds out TODAY instead of when the video runs overdue; the
  // photographer also gets a bell+SMS pointing at their upload page.
  // Skipped for manually-queued jobs: no footage in the folder is EXPECTED for
  // old-footage / externally-shot work, and the wrong "upload your video" text
  // would chase a photographer who owes nothing.
  if (!manualTask && dropbox && (dropbox.rawVideo ?? 0) === 0) {
    const street = (p.title || "this job").split(",")[0].trim();
    const first = (p.photographer?.name || "the photographer").split(/\s+/)[0];
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: NUDGE_KEY } });
    if (!existing) {
      const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
      await prisma.smartTask.create({
        data: {
          taskType: "todo", // swept by nothing; ensureEditorHandoff clears it when footage appears
          title: `Find the raw video — ${street}`.slice(0, 120),
          summary: `A video is ordered for ${street} but the RAW-Video folder shows no files. Either ${first} hasn't uploaded the footage yet, or it's sitting in a folder the hub isn't watching (naming mismatch). The edit can't start until this is found.`,
          description: `Check the Dropbox listing folder for ${street}. If the footage is there under a different name, move it into 02-RAW-Video. If it isn't, chase ${first} — the video clock is running.`,
          reasonCreated: "Video ordered, raw footage not found",
          checklist: JSON.stringify([
            "Open the listing's Dropbox folder",
            `If missing: text ${first} for the footage`,
            "Confirm files land in 02-RAW-Video",
          ]),
          source: "system",
          priority: "HIGH",
          dueAt: new Date(Date.now() + 4 * HOUR),
          assignedKey: "kyle",
          projectId,
          clientId: p.clientId,
          propertyAddress: p.title,
          ownerId: kyle?.id ?? null,
          dedupeKey: NUDGE_KEY,
        },
      });
      try {
        const { notifyInApp } = await import("@/lib/notify");
        const targets = await creativeAlertTargets(p.photographerId, `/upload/${projectId}`);
        await notifyInApp({
          kind: "raws_missing",
          title: `Video files needed — ${street}`,
          href: `/projects/${projectId}`,
          targets,
          dedupeKey: `raw-video-missing-bell-${projectId}`,
        });
      } catch { /* nudge bell is best-effort */ }
    }
    return; // hold the edit task until footage is findable
  }

  // Footage is in (or Dropbox unreadable — don't block on unknown): clear the
  // nudge and make sure the editor's accountable work item exists.
  await clearNudge();
  if (!anyRaw) return; // nothing detected at all → nothing to hand off yet

  await mintEditTask(projectId); // creates if absent; refreshes if open; skips completed

  // 5. Resurrect a falsely-completed work item: task COMPLETED but no cut
  // anywhere (no submission, no video evidence — checked above) and no open
  // revision carrying the work instead. This is how the 5-Nathaniel-Ct class of
  // silent losses self-heals: the sweep notices the video is still owed and
  // puts the job back on the editor's Do-now.
  try {
    const t = await prisma.smartTask.findUnique({
      where: { dedupeKey: `edit-video-${projectId}` },
      select: { id: true, status: true },
    });
    if (t?.status === "COMPLETED") {
      const openRevision = await prisma.smartTask.count({
        where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      });
      if (openRevision === 0) {
        await prisma.smartTask.update({
          where: { id: t.id },
          data: { status: "OPEN", completedAt: null },
        });
        await prisma.activity.create({
          data: {
            projectId,
            type: "SYSTEM",
            body: "Edit task reopened — the video is still owed but its work item had been closed with no cut on file.",
          },
        });
      }
    }
  } catch { /* resurrection is best-effort */ }
}

// ---------------------------------------------------------------------------
// RAWS MISSING watchdog — the "shoot happened, nothing ever landed" alarm the
// system never had (877 S York sat SCHEDULED for 11 days with nobody told —
// July 2026 audit). Called by the sweep for BOOKED/SCHEDULED jobs whose shoot
// is in the past. Mints ONE deduped chase task on Kyle + bell/SMS to the
// photographer once the raws are 18+ hours late; self-clears when files land.
// ---------------------------------------------------------------------------
const RAWS_MISSING_AFTER_MS = 18 * HOUR;

// Who hears about a creative's field problem, beyond the person themselves.
// ADMIN is a role broadcast (Kyle) so it survives a rename; the Creative
// Manager is addressed personally because they need it on their phone, and the
// roles list is deliberately broad so the row stays visible on the day their
// AppUser role changes (a tm: row is invisible unless its audience contains the
// recipient's CURRENT role — a promotion would otherwise silently mute them).
async function creativeAlertTargets(
  shooterId: string | null | undefined,
  href: string,
): Promise<import("@/lib/notify").NotifyTarget[]> {
  const targets: import("@/lib/notify").NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
  const manager = await prisma.teamMember
    .findFirst({ where: { creativeManager: true, active: true }, select: { id: true } })
    .catch(() => null);
  if (manager && manager.id !== shooterId) {
    targets.push({ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${manager.id}`, href });
  }
  if (shooterId) targets.push({ roles: ["PHOTOGRAPHER"], userKey: `tm:${shooterId}`, href });
  return targets;
}

export async function reconcileRawsMissing(
  projectId: string,
  sig: { rawsKnownEmpty: boolean; anyAryeoMedia: boolean },
): Promise<void> {
  const key = `raws-missing-${projectId}`;
  // Raws showed up (or Aryeo already has media, or Dropbox was unreadable —
  // unknown is not proof of absence): close any open watchdog task and stop.
  if (!sig.rawsKnownEmpty || sig.anyAryeoMedia) {
    await prisma.smartTask.updateMany({
      where: { dedupeKey: key, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return;
  }
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return; // one nag per project

  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true,
      clientId: true,
      shootDate: true,
      photographerId: true,
      photographer: { select: { name: true } },
      appointments: { select: { status: true, startAt: true } },
    },
  });
  if (!p) return;

  // When did the shoot actually happen? Latest PAST non-canceled appointment
  // leg, else the (past) shootDate — same semantics as the sweep's shootHappened.
  const now = Date.now();
  const legs = p.appointments
    .filter((a) => (a.status || "").toUpperCase() !== "CANCELED" && a.startAt && a.startAt.getTime() < now)
    .map((a) => a.startAt!.getTime());
  if (p.shootDate && p.shootDate.getTime() < now) legs.push(p.shootDate.getTime());
  const shotAt = legs.length ? Math.max(...legs) : null;
  if (!shotAt || now - shotAt < RAWS_MISSING_AFTER_MS) return; // give them the evening

  const street = (p.title || "this job").split(",")[0].trim();
  const first = (p.photographer?.name || "the photographer").split(/\s+/)[0];
  const hoursLate = Math.round((now - shotAt) / HOUR);
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "todo", // swept by nothing; this watchdog clears it itself when raws land
      title: `No raws uploaded — ${street}`.slice(0, 120),
      summary: `${first} shot ${street} ~${hoursLate}h ago and the raw folders are still empty. Nothing downstream (editing, QC, delivery) can start until the files land — chase it now.`,
      description: `If ${first} uploaded somewhere else, move the files into the listing's 01-RAW-Photos / 02-RAW-Video folders. If not, get an ETA. The delivery clock started at the shoot.`,
      reasonCreated: "Shoot happened, no raw files ever landed",
      checklist: JSON.stringify([
        `Text ${first} — where are the files?`,
        "Check the Dropbox folder naming matches the listing",
        "Confirm the raws land",
      ]),
      source: "system",
      priority: "HIGH",
      dueAt: new Date(now + 4 * HOUR),
      assignedKey: "kyle",
      projectId,
      clientId: p.clientId,
      propertyAddress: p.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: key,
    },
  });
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const targets = await creativeAlertTargets(p.photographerId, `/upload/${projectId}`);
    await notifyInApp({
      kind: "raws_missing",
      title: `Upload needed — ${street}`,
      href: `/projects/${projectId}`,
      targets,
      dedupeKey: `raws-missing-bell-${projectId}`,
    });
  } catch { /* watchdog bell is best-effort */ }
}

// Generate (idempotently) the expected tasks for every ACTIVE project.
export async function generateTasksForActiveProjects(): Promise<{ created: number; projects: number }> {
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const { confirmationMessage } = await import("@/lib/delivery");
  // Retire legacy PER-DELIVERABLE "QA <type>" tasks (they had a deliverableType).
  // They're replaced by ONE consolidated QC task per project (deliverableType
  // null) with a checkbox per deliverable.
  await prisma.smartTask.updateMany({
    where: { taskType: "media_qa", deliverableType: { not: null }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED" },
  });
  // Retire legacy "Confirmation call" tasks — we send a confirmation TEXT now
  // (the confirmation_text task below carries the drafted message + send button).
  await prisma.smartTask.updateMany({
    where: { taskType: "appointment_prep", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED" },
  });
  const projects = await prisma.project.findMany({
    where: { status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] } },
    include: {
      deliverables: { select: { type: true, label: true } },
      // segment drives the VIP extra-pass ticks on the guided QC checklist.
      client: { select: { id: true, name: true, socialClient: true, segment: true } },
      photographer: { select: { name: true } },
    },
  });

  let created = 0;
  for (const p of projects) created += await syncOneProjectTasks(p, kyle, confirmationMessage);
  return { created, projects: projects.length };
}

// REVISION is included so a QC card reopened by reflectRevisionInQc keeps
// getting evidence merges + the moot sweeps keep running — a REVISION-stage
// job used to be invisible to this reconciler and its tasks froze until a
// human resolved the revision (audit #17).
const ACTIVE_TASK_STATUSES = ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"];

// Regenerate/reconcile a SINGLE project's tasks right now. The Aryeo webhook
// calls this so a new order / delivery / appointment change produces or clears
// its tasks at event time instead of waiting up to an hour for the cron.
export async function generateTasksForProject(projectId: string): Promise<number> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      deliverables: { select: { type: true, label: true } },
      // segment drives the VIP extra-pass ticks on the guided QC checklist.
      client: { select: { id: true, name: true, socialClient: true, segment: true } },
      photographer: { select: { name: true } },
    },
  });
  if (!p || !ACTIVE_TASK_STATUSES.includes(p.status)) return 0;
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const { confirmationMessage } = await import("@/lib/delivery");
  return syncOneProjectTasks(p, kyle, confirmationMessage);
}

type TaskProject = {
  id: string; status: string; title: string; shootDate: Date | null; statusEvidence: string | null;
  squareFeet: number | null; photoTarget: number | null;
  deliverables: { type: string; label: string | null }[];
  client: { id: string; name: string | null; socialClient: boolean; segment: string | null };
  photographer: { name: string } | null;
};

// Dedupe-key families minted OUTSIDE this reconciler (webhooks/integrations).
// Their keys aren't sha1 spec hashes, so they never appear in expectedKeys — the
// reconciler used to read that as "no longer expected" and auto-complete them
// within the hour (the Frame.io "Review finals" task self-destructed on first
// use — audit crack #20). Externally-minted tasks are closed by their OWN flows.
const EXTERNAL_KEY_PREFIXES = ["frameio-review-", "scripting-script-", "scripting-client-", "luma-", "slack-", "lead-", "edit-video-"];

// Reconcile one active project's expected tasks (create missing, refresh QC /
// delivery, retire what's no longer expected). Returns how many it created.
async function syncOneProjectTasks(
  p: TaskProject,
  kyle: { id: string } | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  confirmationMessage: (...args: any[]) => string,
): Promise<number> {
  let created = 0;
  // edit_video is externally-minted (mintEditTask, off the →SHOT hook), so it's
  // NOT in `specs` and the spec-based sweep never touches it (edit-video- is in
  // EXTERNAL_KEY_PREFIXES). Close it here on EVIDENCE the cut landed — the final
  // video is on Aryeo/Dropbox (present.Video / dropbox.finalVideo), the editor
  // submitted it through the Review Room, or the job is DELIVERED. Status REVIEW
  // alone is deliberately NOT evidence: the status engine derives REVIEW for
  // PARTIAL deliveries too (photos live, video explicitly missing — the NORMAL
  // staged flow), and using it here auto-completed the editor's only work item
  // within the hour of photo delivery while the reel was still unmade (July
  // 2026 audit, proven live on 5 Nathaniel Ct). Mirrors how media_qa auto-closes
  // on positive evidence: an editor's finished cut shouldn't sit open forever.
  // REVISION deliberately does NOT close it — a bounced reel is back on the
  // editor's plate. Best-effort; wrapped so a stray parse can't break the sync.
  // During REVISION every "landed" signal (present.Video, dropbox.finalVideo,
  // a past ReviewSubmission) describes the PREVIOUS, bounced cut — closing the
  // editor's work item off that evidence would erase the redo. The comment
  // above always declared this; now that REVISION projects actually reach this
  // reconciler, enforce it by skipping the evidence-close entirely.
  if (p.status !== "REVISION") try {
    let finalVideoLanded = p.status === "DELIVERED";
    if (!finalVideoLanded && p.statusEvidence) {
      const ev = JSON.parse(p.statusEvidence) as {
        present?: string[];
        dropbox?: { finalVideo?: number } | null;
      };
      finalVideoLanded =
        (ev.present ?? []).includes("Video") || (ev.dropbox?.finalVideo ?? 0) > 0;
    }
    // The editor said "done" through the Review Room — the cut is with the owner
    // (any round, any verdict state) and their work item was already completed
    // by submitCutForReview; treat as landed so nothing here fights that flow.
    if (!finalVideoLanded) {
      finalVideoLanded =
        (await prisma.reviewSubmission.count({ where: { projectId: p.id } })) > 0;
    }
    if (finalVideoLanded) {
      await prisma.smartTask.updateMany({
        where: {
          projectId: p.id,
          taskType: "edit_video",
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          // A manually-(re)opened edit is NEW work a human just asked for — the
          // "landed" evidence here is the PREVIOUS cut (old finalVideo file, a
          // past ReviewSubmission, a live listing video), so it must not close
          // it. Manual edits close only via the editor's "send to review".
          assignedManually: false,
        },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    }
  } catch { /* evidence-close is best-effort */ }
  // One draft per project — the confirmation text is (re)rendered at creation,
  // on reopen, and on a due-date drift, always from the same current fields.
  const draftConfirmation = () =>
    confirmationMessage({ title: p.title, shootDate: p.shootDate, client: { name: p.client.name ?? "" }, photographer: p.photographer, deliverables: p.deliverables });
  const specs = specsForProject({
    status: p.status,
    title: p.title,
    shootDate: p.shootDate,
    deliverables: p.deliverables,
    statusEvidence: p.statusEvidence,
    // PROJECT-level: a listing shoot for a social-plan client is NOT monthly
    // content — the client flag alone gave listing jobs the 7–10-day QC copy
    // and SLA (caught live July 2026).
    monthlyContent: isMonthlyContentJob(p.deliverables),
    squareFeet: p.squareFeet,
    photoTarget: p.photoTarget,
    clientSegment: p.client.segment,
  });
  // Reconcile: close any open production task that's no longer expected. This
  // retires "QA photos" / "Deliver gallery" once the photos are live (even
  // while a reel is still rendering), and clears a stale "finish delivery"
  // when its missing items showed up or fell back inside their window.
  const expectedKeys = new Set(specs.map((s) => dedupe([p.id, s.taskType, s.deliverableType])));
  await prisma.smartTask.updateMany({
    where: {
      projectId: p.id,
      // During REVISION the QC card is a reflectRevisionInQc-reopened row whose
      // spec may not be emitted at all (everything reads "live" — the OLD cut
      // is what's live, that's why it's in revision). "No longer expected" must
      // never complete media_qa mid-revision; its closes are the human re-QC
      // tick or resolveRevision. delivery/finish_delivery still retire (that's
      // how frozen legacy cards on REVISION jobs finally clear).
      taskType: { in: p.status === "REVISION" ? ["delivery", "finish_delivery"] : ["media_qa", "delivery", "finish_delivery"] },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      NOT: [
        { dedupeKey: { in: [...expectedKeys] } },
        // Never auto-close externally-minted tasks (Frame.io review handoffs etc.)
        // just because this reconciler didn't expect their key.
        ...EXTERNAL_KEY_PREFIXES.map((pfx) => ({ dedupeKey: { startsWith: pfx } })),
      ],
    },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  // A confirmation whose spec vanished (shoot day passed / job moved past
  // SCHEDULED) was never sent through the hub — it's MOOT, not done. Stamp it
  // CANCELLED so the Done ledger stops crediting never-sent confirmations as
  // sent (audit: ~40% of "completed" confirmations were these). The
  // follow-the-shoot reopen below already handles CANCELLED → OPEN when the
  // spec re-emits with a fresh shoot date.
  await prisma.smartTask.updateMany({
    where: {
      projectId: p.id,
      taskType: "confirmation_text",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      NOT: [
        { dedupeKey: { in: [...expectedKeys] } },
        ...EXTERNAL_KEY_PREFIXES.map((pfx) => ({ dedupeKey: { startsWith: pfx } })),
      ],
    },
    data: { status: "CANCELLED" },
  });
  for (const s of specs) {
    const key = dedupe([p.id, s.taskType, s.deliverableType]);
    const exists = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
    if (exists) {
      // The confirmation follows the shoot even out of a terminal state. Its
      // dedupe key is deliberately date-less (changing it would re-mint
      // duplicates for every already-confirmed project), so a fresh task can
      // never appear — the existing row must be REOPENED instead:
      //   · COMPLETED: the client confirmed the OLD time — void once the spec's
      //     dueAt (shoot - 1 day) drifts >= 1h, or when the confirmation was
      //     completed while the job had NO shoot date and a real one landed.
      //     The 1h guard keeps bulk-auto-closed tasks from flapping when
      //     nothing actually moved.
      //   · CANCELLED: the dead-slot sweep in aryeo.ts cancels it when a shoot
      //     is postponed; the spec re-emitting WITH a dueAt means the shoot is
      //     back on the books.
      // No ping-pong with the auto-close sweep above: this reopen only fires
      // while the spec IS emitted (key in expectedKeys), the sweep only when it
      // is NOT — mutually exclusive by construction. Nulling completedAt
      // mirrors the media_qa reopen, so /history stops counting it as a sent
      // confirmation until it's re-sent. Every OTHER task type keeps its
      // terminal states terminal.
      if (s.taskType === "confirmation_text" && (exists.status === "CANCELLED" || exists.status === "COMPLETED")) {
        if (s.dueAt) {
          const rebooked = exists.status === "CANCELLED";
          const drifted = !exists.dueAt || Math.abs(s.dueAt.getTime() - exists.dueAt.getTime()) >= HOUR;
          if (rebooked || drifted) {
            await prisma.smartTask.update({
              where: { id: exists.id },
              data: {
                status: "OPEN",
                completedAt: null,
                dueAt: s.dueAt,
                priority: computePriority({ dueAt: s.dueAt, shootDate: p.shootDate, status: p.status }),
                description: draftConfirmation(),
                reasonCreated: rebooked
                  ? "Shoot was re-booked after being postponed — confirm the new time with the client"
                  : "Shoot was rescheduled after the last confirmation — confirm the new time with the client",
              },
            });
          }
        }
        continue;
      }
      if (exists.status === "CANCELLED") continue;
      // For the consolidated QC task, re-sync its checklist each run: an item
      // is checked if it's live on Aryeo OR Kyle already ticked it manually
      // (manual checks are preserved). If every item ends up checked, the task
      // auto-completes. Also keep the due date fresh. The checklist is no longer
      // an interactive UI — it drives this auto-close + the read-only status row.
      if (s.taskType === "media_qa") {
        const prev = parseChecklist(exists.checklist);
        const prevDone = new Map(prev.map((i) => [i.label, i.done]));
        const specLabels = new Set(s.checklist.map((i) => i.label));
        // Keep any item the SPEC didn't produce (e.g. a revision-injected
        // "Re-QC after revision" / "QC Reel (revision)" from reflectRevisionInQc)
        // with its done state — otherwise it'd be silently dropped and the task
        // could auto-complete while a re-QC was still pending.
        const extras = prev.filter((i) => !specLabels.has(i.label));
        const merged: ChecklistItem[] = [
          ...s.checklist.map((i) => ({ label: i.label, done: i.done || (prevDone.get(i.label) ?? false) })),
          ...extras,
        ];
        const allDone = checklistComplete(merged);
        // A COMPLETED QC whose evidence still shows unchecked work on a live
        // SHOT/EDITING/REVIEW job was almost certainly auto-closed by this
        // reconciler during a transient signal blip (a demoted-then-healed job) —
        // REOPEN it: auto-close requires positive evidence, and a completed
        // dedupe key is never re-minted, so the work would vanish forever
        // (audit crack #2). If everything IS live, leave the completion alone.
        if (exists.status === "COMPLETED" && allDone) continue;
        // During REVISION this reconciler must never flip the card COMPLETED —
        // every "done" signal describes the PREVIOUS accepted cut (the old
        // media is what's live on Aryeo), so a stale ticked re-QC row would
        // close the gate with zero human re-look. Mid-revision closes belong
        // to the human tick path (toggleTaskChecklistItem) or resolveRevision
        // ONLY. It also keeps reflectRevisionInQc's framing (HIGH, dueAt=raise
        // time, revision copy) instead of the spec's shoot-anchored values.
        const inRevision = p.status === "REVISION";
        // A real completion this run: everything (incl. Kyle's failure-mode ticks)
        // is done and the task wasn't already closed. Log the QC pass for the
        // owner dial. Best-effort + deduped so the interactive-toggle path (which
        // also logs) can't double-write. Do it BEFORE the status flip so a throw
        // can't leave a completed task with no record — recordQcCompletion swallows.
        const nowCompleting = allDone && !inRevision && exists.status !== "COMPLETED";
        if (nowCompleting) {
          try {
            await recordQcCompletion({
              projectId: p.id,
              items: merged,
              clientSegment: p.client.segment,
              completedBy: exists.assignedKey ?? "kyle",
            });
          } catch { /* analytics only — never block auto-close */ }
        }
        await prisma.smartTask.update({
          where: { id: exists.id },
          data: {
            checklist: serializeChecklist(merged),
            ...(s.summary && !inRevision ? { summary: s.summary } : {}),
            // Post-shoot QC: priced by its turnaround due date, NOT shoot proximity
            // (a 7–10 day monthly job shouldn't read URGENT because it shot today).
            ...(s.dueAt && !inRevision ? { dueAt: s.dueAt, priority: computePriority({ dueAt: s.dueAt, status: p.status }) } : {}),
            ...(allDone && !inRevision
              ? { status: "COMPLETED", completedAt: new Date() }
              : exists.status === "COMPLETED"
                ? {
                    status: "OPEN",
                    completedAt: null,
                    // Reopening a delivered-era card mid-revision (the manual
                    // prior-cut rail flips a job to REVISION without going
                    // through reflectRevisionInQc): stamp the revision framing
                    // so Kyle doesn't get a weeks-overdue "QC & deliver" card.
                    ...(inRevision
                      ? {
                          priority: "HIGH",
                          dueAt: new Date(),
                          summary: "Back into revision — re-QC the fixed items before they go back to the client.",
                        }
                      : {}),
                  }
                : {}),
          },
        });
        continue;
      }
      // Other completed task types stay closed — only the confirmation (handled
      // above) follows the shoot.
      if (exists.status === "COMPLETED") continue;
      // A rescheduled shoot (or a turnaround-rule change, for delivery-type
      // tasks) moves the spec's dueAt — any still-open task has to
      // follow it (>= 1h drift, so rounding noise doesn't churn writes) or it
      // surfaces in the morning brief on the WRONG day and then sits overdue.
      // Priority rides along, same formula as the creation path below. The
      // confirmation's drafted preview embeds the old date/time and
      // sendConfirmationText re-renders fresh at send time — re-render here too
      // so the draft Kyle reviews matches what actually gets sent.
      if (s.dueAt && (!exists.dueAt || Math.abs(s.dueAt.getTime() - exists.dueAt.getTime()) >= HOUR)) {
        const postShoot = ["media_qa", "delivery", "delivery_text"].includes(s.taskType);
        await prisma.smartTask.update({
          where: { id: exists.id },
          data: {
            dueAt: s.dueAt,
            priority: computePriority({ dueAt: s.dueAt, shootDate: postShoot ? null : p.shootDate, status: p.status }),
            ...(s.taskType === "confirmation_text" ? { description: draftConfirmation() } : {}),
          },
        });
      }
      continue;
    }
    // Pre-shoot tasks (confirmation) factor shoot proximity; post-shoot production
    // (QC / deliver / delivery text) is priced by its turnaround due date only.
    const postShoot = ["media_qa", "delivery", "delivery_text"].includes(s.taskType);
    const priority = computePriority({ dueAt: s.dueAt, shootDate: postShoot ? null : p.shootDate, status: p.status });
    // Pre-draft the confirmation text so Kyle just reviews + sends.
    const description = s.taskType === "confirmation_text" ? draftConfirmation() : s.description ?? null;
    await prisma.smartTask.create({
      data: {
        taskType: s.taskType,
        title: s.title,
        summary: s.summary ?? null,
        description,
        reasonCreated: s.reasonCreated,
        checklist: serializeChecklist(s.checklist),
        assignedKey: s.assignedKey ?? null,
        source: "aryeo",
        priority,
        dueAt: s.dueAt ?? null,
        deliverableType: s.deliverableType ?? null,
        projectId: p.id,
        clientId: p.client.id,
        propertyAddress: p.title,
        ownerId: kyle?.id ?? null,
        dedupeKey: key,
      },
    });
    created++;
  }
  return created;
}
