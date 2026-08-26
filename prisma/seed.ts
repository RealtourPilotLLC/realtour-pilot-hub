// ---------------------------------------------------------------------------
// SAFETY GUARD (audit Aug 25): this script DELETES data, and the local .env
// points DATABASE_URL at the LIVE Neon production database shared with the
// deployed app. Refuse to run against it. tsx does NOT autoload .env (Prisma
// does), so read the file directly rather than trusting process.env alone.
// ---------------------------------------------------------------------------
import { readFileSync } from "fs";
{
  let dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl) {
    try { dbUrl = /^DATABASE_URL\s*=\s*"?([^"\n]+)/m.exec(readFileSync(".env", "utf8"))?.[1] ?? ""; } catch { /* no .env */ }
  }
  if (/neon\.tech|vercel|amazonaws/i.test(dbUrl) && process.env.I_UNDERSTAND_THIS_WIPES_PROD !== "yes") {
    console.error("REFUSING TO RUN: DATABASE_URL points at a hosted (production) database — this script would DELETE live data.");
    console.error("If you truly mean it, run with I_UNDERSTAND_THIS_WIPES_PROD=yes.");
    process.exit(1);
  }
}

import {
  PrismaClient,
  Role,
  ProjectStatus,
  Priority,
  DeliverableType,
  DeliverableStatus,
  ActivityType,
} from "@prisma/client";

const prisma = new PrismaClient();

// Helpers for relative dates so seeded data always looks "current".
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysFromNow = (d: number) => new Date(now + d * DAY);

async function main() {
  console.log("Resetting data…");
  await prisma.activity.deleteMany();
  await prisma.checklistItem.deleteMany();
  await prisma.deliverable.deleteMany();
  await prisma.project.deleteMany();
  await prisma.client.deleteMany();
  await prisma.teamMember.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.sop.deleteMany();

  // ----- Team -------------------------------------------------------------
  console.log("Seeding team…");
  const jordan = await prisma.teamMember.create({
    data: { name: "Jordan Spackman", email: "info@realtourpilot.com", role: Role.ADMIN, avatarColor: "#4f46e5" },
  });
  // Owner login account (idempotent) — so a fresh DB always has an active OWNER
  // and turning on AUTH_ENFORCE can never lock everyone out (the callback denies
  // any email without an AppUser row).
  await prisma.appUser.upsert({
    where: { email: "info@realtourpilot.com" },
    update: { role: "OWNER", status: "ACTIVE" },
    create: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id },
  });
  const kyle = await prisma.teamMember.create({
    data: { name: "Kyle", email: "kyle@realtourpilot.com", role: Role.MANAGER, avatarColor: "#0ea5e9" },
  });
  const maya = await prisma.teamMember.create({
    data: { name: "Maya Torres", email: "maya@realtourpilot.com", role: Role.PHOTOGRAPHER, avatarColor: "#8b5cf6" },
  });
  const devin = await prisma.teamMember.create({
    data: { name: "Devin Park", email: "devin@realtourpilot.com", role: Role.PHOTOGRAPHER, avatarColor: "#ec4899" },
  });
  const sam = await prisma.teamMember.create({
    data: { name: "Sam Rivera", email: "sam@realtourpilot.com", role: Role.EDITOR, avatarColor: "#d97706" },
  });
  const lena = await prisma.teamMember.create({
    data: { name: "Lena Cho", email: "lena@realtourpilot.com", role: Role.EDITOR, avatarColor: "#f59e0b" },
  });
  const ana = await prisma.teamMember.create({
    data: { name: "Ana (VA)", email: "ana@realtourpilot.com", role: Role.VA, avatarColor: "#16a34a" },
  });

  // ----- Clients ----------------------------------------------------------
  console.log("Seeding clients…");
  const carter = await prisma.client.create({
    data: {
      name: "Carter Reynolds",
      email: "carter@summithomes.com",
      phone: "(801) 555-0142",
      company: "Summit Realty Group",
      editingPreferences: "Bright & airy, true-to-life skies, light HDR. NO over-saturation.",
      generalNotes: "High-volume agent (~6 listings/mo). Always wants next-day delivery. Texts, doesn't email.",
    },
  });
  const bianca = await prisma.client.create({
    data: {
      name: "Bianca Lowe",
      email: "bianca@coastlineproperties.com",
      phone: "(801) 555-0177",
      company: "Coastline Properties",
      editingPreferences: "Warm tones, cozy feel. Loves twilight shots. Wants grass greened up.",
      generalNotes: "Detail-oriented, leaves long shot notes. Prefers a call before luxury shoots.",
    },
  });
  const marcus = await prisma.client.create({
    data: {
      name: "Marcus Bell",
      email: "marcus@bellandco.com",
      phone: "(385) 555-0119",
      company: "Bell & Co.",
      editingPreferences: "Clean, MLS-standard. Straight verticals are a must.",
      generalNotes: "New client (2nd order). Price-sensitive — quote add-ons clearly.",
    },
  });
  const priya = await prisma.client.create({
    data: {
      name: "Priya Anand",
      email: "priya@anandluxury.com",
      phone: "(801) 555-0188",
      company: "Anand Luxury Estates",
      editingPreferences: "Magazine-grade. Heavy sky replacement OK. Virtual staging for vacants.",
      generalNotes: "Luxury only. Expects white-glove. Worth the extra QC pass.",
    },
  });

  // ----- Projects ---------------------------------------------------------
  console.log("Seeding projects…");

  // A small factory to cut repetition.
  type DSpec = { type: DeliverableType; status?: DeliverableStatus; qty?: number; notes?: string };
  type CSpec = { label: string; done?: boolean; forRole?: Role; assigneeId?: string; dueDays?: number };
  type ASpec = { type: ActivityType; body: string; authorId?: string; daysAgo?: number };

  async function project(opts: {
    title: string;
    clientId: string;
    status: ProjectStatus;
    priority?: Priority;
    addressLine?: string;
    city?: string;
    state?: string;
    zip?: string;
    squareFeet?: number;
    packageName?: string;
    price?: number;
    shootInDays?: number;
    dueInDays?: number;
    deliveredDaysAgo?: number;
    photographerId?: string;
    editorId?: string;
    vaId?: string;
    notes?: string;
    deliverables?: DSpec[];
    checklist?: CSpec[];
    activities?: ASpec[];
  }) {
    const p = await prisma.project.create({
      data: {
        title: opts.title,
        clientId: opts.clientId,
        status: opts.status,
        priority: opts.priority ?? Priority.NORMAL,
        addressLine: opts.addressLine,
        city: opts.city,
        state: opts.state ?? "UT",
        zip: opts.zip,
        squareFeet: opts.squareFeet,
        packageName: opts.packageName,
        price: opts.price,
        shootDate: opts.shootInDays != null ? daysFromNow(opts.shootInDays) : null,
        deliveryDue: opts.dueInDays != null ? daysFromNow(opts.dueInDays) : null,
        deliveredAt: opts.deliveredDaysAgo != null ? daysFromNow(-opts.deliveredDaysAgo) : null,
        photographerId: opts.photographerId,
        editorId: opts.editorId,
        vaId: opts.vaId,
        notes: opts.notes,
        deliverables: {
          create: (opts.deliverables ?? []).map((d) => ({
            type: d.type,
            quantity: d.qty ?? 1,
            status: d.status ?? DeliverableStatus.PENDING,
            notes: d.notes,
          })),
        },
        checklist: {
          create: (opts.checklist ?? []).map((c, i) => ({
            label: c.label,
            done: c.done ?? false,
            forRole: c.forRole,
            assigneeId: c.assigneeId,
            dueAt: c.dueDays != null ? daysFromNow(c.dueDays) : null,
            sortOrder: i,
          })),
        },
        activities: {
          create: (opts.activities ?? []).map((a) => ({
            type: a.type,
            body: a.body,
            authorId: a.authorId,
            createdAt: a.daysAgo != null ? daysFromNow(-a.daysAgo) : undefined,
          })),
        },
      },
    });
    return p;
  }

  await project({
    title: "1420 Oakridge Dr",
    clientId: carter.id,
    status: ProjectStatus.BOOKED,
    priority: Priority.HIGH,
    addressLine: "1420 Oakridge Dr",
    city: "Salt Lake City",
    zip: "84109",
    squareFeet: 3200,
    packageName: "Premium (Photos + Video + Floor Plan)",
    price: 425,
    dueInDays: 4,
    vaId: ana.id,
    notes: "Carter wants next-day delivery as usual. Confirm gate code before shoot.",
    deliverables: [
      { type: DeliverableType.PHOTOS, qty: 35 },
      { type: DeliverableType.VIDEO },
      { type: DeliverableType.FLOORPLAN },
    ],
    checklist: [
      { label: "Confirm shoot date with Carter", forRole: Role.VA, assigneeId: ana.id, done: true },
      { label: "Assign photographer", forRole: Role.MANAGER, assigneeId: kyle.id },
      { label: "Send pre-shoot prep checklist to seller", forRole: Role.VA, assigneeId: ana.id },
    ],
    activities: [
      { type: ActivityType.SYSTEM, body: "Order imported from Aryeo.", daysAgo: 1 },
      { type: ActivityType.SPECIAL_REQUEST, body: "Client requested next-day delivery (standard for this agent).", authorId: ana.id, daysAgo: 1 },
    ],
  });

  await project({
    title: "88 Lakeview Terrace",
    clientId: bianca.id,
    status: ProjectStatus.SCHEDULED,
    priority: Priority.NORMAL,
    addressLine: "88 Lakeview Terrace",
    city: "Draper",
    zip: "84020",
    squareFeet: 4100,
    packageName: "Luxury (Photos + Twilight + Drone)",
    price: 650,
    shootInDays: 2,
    dueInDays: 5,
    photographerId: maya.id,
    vaId: ana.id,
    notes: "Twilight shoot — arrive 45 min before golden hour. Bianca wants grass greened up.",
    deliverables: [
      { type: DeliverableType.PHOTOS, qty: 40 },
      { type: DeliverableType.TWILIGHT, qty: 5 },
      { type: DeliverableType.DRONE, qty: 8 },
    ],
    checklist: [
      { label: "Confirm twilight timing with seller", forRole: Role.VA, assigneeId: ana.id, done: true },
      { label: "Charge drone batteries", forRole: Role.PHOTOGRAPHER, assigneeId: maya.id },
      { label: "Check airspace / LAANC authorization", forRole: Role.PHOTOGRAPHER, assigneeId: maya.id },
    ],
    activities: [
      { type: ActivityType.ASSIGNMENT, body: "Assigned to Maya Torres.", authorId: kyle.id, daysAgo: 3 },
      { type: ActivityType.SPECIAL_REQUEST, body: "Bianca: please green up the lawn, it's a bit patchy.", authorId: ana.id, daysAgo: 2 },
    ],
  });

  await project({
    title: "552 Birchwood Ln",
    clientId: marcus.id,
    status: ProjectStatus.SHOT,
    priority: Priority.NORMAL,
    addressLine: "552 Birchwood Ln",
    city: "Sandy",
    zip: "84070",
    squareFeet: 2400,
    packageName: "Standard (Photos + Floor Plan)",
    price: 285,
    shootInDays: -1,
    dueInDays: 1,
    photographerId: devin.id,
    notes: "Straight verticals are a must for Marcus.",
    deliverables: [
      { type: DeliverableType.PHOTOS, qty: 28, status: DeliverableStatus.UPLOADED },
      { type: DeliverableType.FLOORPLAN, status: DeliverableStatus.UPLOADED },
    ],
    checklist: [
      { label: "Upload raw photos to Dropbox", forRole: Role.PHOTOGRAPHER, assigneeId: devin.id, done: true },
      { label: "Upload floor plan scan", forRole: Role.PHOTOGRAPHER, assigneeId: devin.id, done: true },
      { label: "Assign editor", forRole: Role.MANAGER, assigneeId: kyle.id },
    ],
    activities: [
      { type: ActivityType.STATUS_CHANGE, body: "Moved to Shot / Uploaded.", authorId: devin.id, daysAgo: 1 },
      { type: ActivityType.NOTE, body: "Front exterior had harsh shadows — got extra brackets for the editor.", authorId: devin.id, daysAgo: 1 },
    ],
  });

  await project({
    title: "9 Summit Vista Ct",
    clientId: priya.id,
    status: ProjectStatus.EDITING,
    priority: Priority.URGENT,
    addressLine: "9 Summit Vista Ct",
    city: "Park City",
    zip: "84060",
    squareFeet: 6800,
    packageName: "Luxury+ (Photos + Video + Drone + Virtual Staging)",
    price: 1250,
    shootInDays: -2,
    dueInDays: 1,
    photographerId: maya.id,
    editorId: lena.id,
    notes: "Magazine-grade. 2 vacant rooms need virtual staging (modern). Extra QC pass.",
    deliverables: [
      { type: DeliverableType.PHOTOS, qty: 50, status: DeliverableStatus.IN_PROGRESS },
      { type: DeliverableType.VIDEO, status: DeliverableStatus.IN_PROGRESS },
      { type: DeliverableType.DRONE, qty: 10, status: DeliverableStatus.DONE },
      { type: DeliverableType.VIRTUAL_STAGING, qty: 2, status: DeliverableStatus.PENDING, notes: "Living room + primary bedroom, modern style." },
    ],
    checklist: [
      { label: "Color-match to Priya's brand profile", forRole: Role.EDITOR, assigneeId: lena.id, done: true },
      { label: "Virtual stage 2 vacant rooms", forRole: Role.EDITOR, assigneeId: lena.id },
      { label: "Sky replacement on exteriors", forRole: Role.EDITOR, assigneeId: lena.id, done: true },
      { label: "Manager QC pass before delivery", forRole: Role.MANAGER, assigneeId: kyle.id },
    ],
    activities: [
      { type: ActivityType.FLAG, body: "Drone footage has a brief gimbal jitter at 0:42 — flagged for editor.", authorId: maya.id, daysAgo: 1 },
      { type: ActivityType.SPECIAL_REQUEST, body: "Priya: stage the primary bedroom too, not just the living room.", authorId: ana.id, daysAgo: 1 },
    ],
  });

  await project({
    title: "207 Maplewood Ave",
    clientId: carter.id,
    status: ProjectStatus.REVIEW,
    priority: Priority.HIGH,
    addressLine: "207 Maplewood Ave",
    city: "Murray",
    zip: "84107",
    squareFeet: 2900,
    packageName: "Premium (Photos + Video + Floor Plan)",
    price: 425,
    shootInDays: -3,
    dueInDays: 0,
    photographerId: devin.id,
    editorId: sam.id,
    notes: "Next-day delivery promised. In QC now.",
    deliverables: [
      { type: DeliverableType.PHOTOS, qty: 32, status: DeliverableStatus.DONE },
      { type: DeliverableType.VIDEO, status: DeliverableStatus.DONE },
      { type: DeliverableType.FLOORPLAN, status: DeliverableStatus.DONE },
    ],
    checklist: [
      { label: "Final edit pass complete", forRole: Role.EDITOR, assigneeId: sam.id, done: true },
      { label: "QC: check verticals & color", forRole: Role.MANAGER, assigneeId: kyle.id },
      { label: "Prep delivery email + gallery link", forRole: Role.VA, assigneeId: ana.id },
    ],
    activities: [
      { type: ActivityType.STATUS_CHANGE, body: "Moved to Review / QC.", authorId: sam.id, daysAgo: 0 },
    ],
  });

  await project({
    title: "33 Canyon Crest Rd",
    clientId: bianca.id,
    status: ProjectStatus.DELIVERED,
    priority: Priority.NORMAL,
    addressLine: "33 Canyon Crest Rd",
    city: "Cottonwood Heights",
    zip: "84121",
    squareFeet: 3500,
    packageName: "Premium (Photos + Twilight)",
    price: 480,
    shootInDays: -6,
    deliveredDaysAgo: 3,
    photographerId: maya.id,
    editorId: lena.id,
    deliverables: [
      { type: DeliverableType.PHOTOS, qty: 38, status: DeliverableStatus.DONE },
      { type: DeliverableType.TWILIGHT, qty: 6, status: DeliverableStatus.DONE },
    ],
    checklist: [
      { label: "Gallery delivered to client", forRole: Role.VA, assigneeId: ana.id, done: true },
      { label: "Request review / feedback", forRole: Role.VA, assigneeId: ana.id, done: true },
    ],
    activities: [
      { type: ActivityType.STATUS_CHANGE, body: "Delivered to client. Gallery link sent.", authorId: ana.id, daysAgo: 3 },
      { type: ActivityType.NOTE, body: "Bianca replied: 'Twilights are gorgeous, thank you!'", authorId: ana.id, daysAgo: 2 },
    ],
  });

  await project({
    title: "714 Willow Bend",
    clientId: marcus.id,
    status: ProjectStatus.ON_HOLD,
    priority: Priority.LOW,
    addressLine: "714 Willow Bend",
    city: "West Jordan",
    zip: "84088",
    squareFeet: 2100,
    packageName: "Standard (Photos)",
    price: 200,
    notes: "On hold — seller pushing dates, waiting for Marcus to reconfirm.",
    vaId: ana.id,
    deliverables: [{ type: DeliverableType.PHOTOS, qty: 25 }],
    checklist: [{ label: "Follow up with Marcus on new date", forRole: Role.VA, assigneeId: ana.id }],
    activities: [
      { type: ActivityType.STATUS_CHANGE, body: "Put on hold — seller rescheduling.", authorId: ana.id, daysAgo: 2 },
    ],
  });

  // ----- Knowledge: resources + SOPs -------------------------------------
  console.log("Seeding resources & SOPs…");
  await prisma.resource.createMany({
    data: [
      { category: "Booking & Calls", title: "Book a discovery call", url: "https://calendly.com/realtourpilot/discovery", icon: "phone", description: "Calendly link for new-client intro calls", sortOrder: 0 },
      { category: "Booking & Calls", title: "Aryeo booking page", url: "https://app.aryeo.com", icon: "calendar", description: "Where orders come in", sortOrder: 1 },
      { category: "Tools", title: "Aryeo", url: "https://app.aryeo.com", icon: "camera", description: "Orders, delivery, invoicing", sortOrder: 0 },
      { category: "Tools", title: "OpenPhone (Quo)", url: "https://my.openphone.com", icon: "phone", description: "Team phone & texts", sortOrder: 1 },
      { category: "Tools", title: "Dropbox", url: "https://www.dropbox.com/home", icon: "folder", description: "Project files & deliverables", sortOrder: 2 },
      { category: "Tools", title: "QuickBooks", url: "https://qbo.intuit.com", icon: "dollar-sign", description: "Accounting & invoices", sortOrder: 3 },
      { category: "Tools", title: "Stripe Dashboard", url: "https://dashboard.stripe.com", icon: "credit-card", description: "Payments & payouts", sortOrder: 4 },
      { category: "Brand Assets", title: "Logo & brand kit", url: "https://www.dropbox.com/home/Brand", icon: "image", description: "Logos, fonts, color palette", sortOrder: 0 },
      { category: "Brand Assets", title: "Editing LUTs & presets", url: "https://www.dropbox.com/home/Presets", icon: "sliders", description: "House editing presets for editors", sortOrder: 1 },
    ],
  });

  await prisma.sop.createMany({
    data: [
      {
        category: "Shooting",
        title: "Standard photo shoot checklist",
        summary: "Pre-shoot prep through on-site capture",
        content:
          "1. Confirm address, gate/lockbox code, and parking the day before.\n2. Arrive 10 min early; introduce yourself to the seller/agent.\n3. Lights on, blinds open, toilet lids down, cars out of driveway.\n4. Shoot wide-to-detail, every room + key exterior angles.\n5. Bracket exteriors for sky recovery.\n6. Upload same day via the Upload Portal and leave editor notes.",
      },
      {
        category: "Shooting",
        title: "Twilight & drone add-ons",
        summary: "When the order includes twilight or aerial",
        content:
          "Twilight: arrive 45 min before sunset, scout angles in daylight, capture the 20-min golden window.\nDrone: check LAANC airspace authorization, charge 2+ batteries, keep VLOS, avoid neighbors' yards.",
      },
      {
        category: "Editing",
        title: "House editing standard",
        summary: "Our baseline look for every gallery",
        content:
          "Bright & airy, true-to-life color, straight verticals always.\nSky replacement only when bracketed and natural-looking.\nMatch each client's saved editing preferences (see their CRM profile).\nDeliver MLS-sized + full-res sets.",
      },
      {
        category: "Delivery",
        title: "Delivery & feedback flow",
        summary: "From QC to client gallery",
        content:
          "1. Manager QC pass: verticals, color, count, special requests met.\n2. Deliver gallery link via Aryeo + branded email.\n3. Mark project Delivered in the pipeline.\n4. VA sends a feedback/review request 24h later.",
      },
      {
        category: "Sales",
        title: "New client intro call",
        summary: "How we talk to a prospective agent",
        content:
          "Goal: understand their volume, style, and pain points.\n- Ask what they shoot now and what frustrates them.\n- Lead with turnaround speed and consistency.\n- Quote packages clearly; note add-ons.\n- Book their first shoot on the call if possible.",
      },
    ],
  });

  const counts = {
    team: await prisma.teamMember.count(),
    clients: await prisma.client.count(),
    projects: await prisma.project.count(),
    deliverables: await prisma.deliverable.count(),
    resources: await prisma.resource.count(),
    sops: await prisma.sop.count(),
  };
  console.log("Done:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
