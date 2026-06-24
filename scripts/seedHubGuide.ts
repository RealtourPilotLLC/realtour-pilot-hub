import { prisma } from "@/lib/prisma";

// Hub self-knowledge: how the platform works, so Ask the Hub can guide people and
// offer practical tips. source="hub-guide" so a re-run replaces just these.
// minRole mostly CREATIVE (anyone may learn the app); money pages are ADMIN.

type Seed = { category: string; title: string; body: string; minRole: string; tags: string[] };

const ITEMS: Seed[] = [
  { category: "hub_help", minRole: "CREATIVE", title: "The hub drafts client messages; a human always sends", body: "Anywhere the hub writes a client text or email (delivery confirmations, replies, scheduling), it only DRAFTS it. Nothing goes to a client until a person reviews it and clicks Send. The hub never auto-sends to clients.", tags: ["messaging", "safety"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Dashboard is the morning brief", body: "The Dashboard (/) is built for Kyle's start of day: today's shoots, a Check Your Messages list of unanswered client texts/emails, what needs attention (overdue or exceptions), and next-day deliveries. Start here each morning.", tags: ["dashboard", "morning"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Daily Tasks is the single to-do queue", body: "Daily Tasks (/queue) is the one list of everything to act on: QC tasks, deliveries, client replies, and confirmations. Tasks have checklists, a Note button, and Send buttons where relevant. Working this list top to bottom is the daily routine.", tags: ["tasks", "queue"] },
  { category: "hub_help", minRole: "CREATIVE", title: "QC is one task per project with checkboxes", body: "Quality control is a single QC task per project with one checkbox per deliverable (QC Photos, QC Reel, etc.), pre-checked for anything already live on Aryeo. Ticking every box auto-completes the task. If a deliverable goes back into revision, the QC task reopens with that item unchecked and labeled revision.", tags: ["qc", "tasks"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Leave a note on a task to post it to the project", body: "The Note button on any task posts your note into that project's message thread, so context lives with the project instead of getting lost. Use it to flag something for the team.", tags: ["tasks", "notes", "messaging"] },
  { category: "hub_help", minRole: "ADMIN", title: "Send a delivery text from the task", body: "When a job is delivered, its delivery task has a Send via OpenPhone button. The hub pre-writes a status-aware text (what is delivered vs still in production) with a feedback-form link; review it and send. It also logs the activity and closes the task.", tags: ["delivery", "messaging"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Reply tasks close when you actually respond", body: "A client reply to-do completes automatically once you reply to that person (by text or email), in real time. You do not have to manually check it off.", tags: ["tasks", "messaging"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Communications: direct vs group threads", body: "Communications (/communications) shows client text and call threads, including group chats. On a client you can switch between texting them directly and the group chat they are part of. Group messages route to the right client's page.", tags: ["communications", "messaging"] },
  { category: "hub_help", minRole: "ADMIN", title: "Clients page is the CRM", body: "Clients (/clients) is grouped by segment tier. Each client page shows their orders, lifetime spend, segment, activity timeline, open to-dos, agent profile and brand assets, plus tools to draft a text, draft an email, or save notes.", tags: ["clients", "crm"] },
  { category: "hub_help", minRole: "ADMIN", title: "Billing shows outstanding AR", body: "Billing (/billing) lists every delivered Aryeo job that still owes money: order details, what was delivered, invoice total, amount outstanding, links to the invoice and Aryeo listing, count of open tasks, and a grand total. Use it to chase payment.", tags: ["billing", "money"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Map shows live shoots with advisories", body: "Map (/map) plots projects with shoot details, weather, traffic, and FAA drone-airspace flags. The distance box has address autocomplete and a copy button, and it shows service territory and the no-mileage radius.", tags: ["map", "schedule"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Upload Portal for photographers", body: "Upload Portal (/upload) groups jobs by shoot day (today, yesterday, past week). Each job has Dropbox drop-links for raw and final photo/video, a deliverable checklist, the editor brief, and a How did the shoot go form that flags issues for Kyle.", tags: ["upload", "photographer"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Editor Queue and vendor routing", body: "Editor Queue (/editing) is the editing pipeline (Shot, Editing, Review). It shows upload status and a Start edit button, and routes work to the right place: photos to AutoHDR, premium reels to Luma Visuals, standard work in-house.", tags: ["editing", "vendors"] },
  { category: "hub_help", minRole: "CREATIVE", title: "Status is cross-checked, and delivery is staged", body: "A project's status is computed from Aryeo media, ordered deliverables, and Dropbox files together, not from a single flag. Delivery is staged on purpose (photos next day, video a few days later), so a job can be partly delivered while the video is still in production. Do not assume fully delivered just because Aryeo says so.", tags: ["status", "delivery"] },
  { category: "hub_help", minRole: "ADMIN", title: "Submit feedback or a feature request", body: "Use Feedback & requests (/feedback), or the floating Feedback button on any page, to send Jordan a feature idea or bug. You can attach a screenshot. Jordan approves it in-app, then it gets built.", tags: ["feedback"] },
  { category: "hub_help", minRole: "ADMIN", title: "Connections manages integrations", body: "Connections (/connections) is where Aryeo, OpenPhone, Gmail, Dropbox, Slack, and the AI are connected and show their status. If something stops syncing, check here first and reconnect.", tags: ["connections", "integrations"] },
  { category: "hub_help", minRole: "CREATIVE", title: "What is live in real time vs polled", body: "Inbound texts and calls (OpenPhone) and Aryeo order, delivery, and appointment changes arrive in real time via webhooks. Gmail is scanned every few minutes. So new shoots, deliveries, and messages show up on their own.", tags: ["sync", "realtime"] },
  { category: "hub_help", minRole: "ADMIN", title: "Task History and day recaps", body: "Task History (/history) shows completed work grouped by day with the shoots and deliveries for each day, plus a Write a recap button that generates a plain-English summary of what happened that day.", tags: ["history", "recap"] },
  { category: "hub_help", minRole: "OWNER", title: "Ask the Hub respects role-based access", body: "Ask the Hub answers from live hub data plus Jordan's distilled business knowledge. The Viewing as selector (Owner, Admin, Creative) controls what it will share. Owner-only items (finances, margins, pay, strategy, personnel) are never shown to lower roles. Real per-user logins and permissions are a planned upgrade.", tags: ["assistant", "access"] },
];

async function main() {
  await prisma.knowledgeItem.deleteMany({ where: { source: "hub-guide" } });
  for (const it of ITEMS) {
    await prisma.knowledgeItem.create({
      data: {
        category: it.category, title: it.title, body: it.body, minRole: it.minRole,
        tags: JSON.stringify(it.tags), source: "hub-guide", pinned: true, confidence: 5, sourceRef: "hub guide",
      },
    });
  }
  console.log(`Seeded ${ITEMS.length} hub-guide items.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
