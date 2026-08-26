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

import { PrismaClient, Role } from "@prisma/client";

// Production seed: team + resources + SOPs only. NO demo clients/projects —
// real data comes from Aryeo. Safe to run against an empty prod database.
const prisma = new PrismaClient();

async function main() {
  console.log("Clean seed: team…");
  const team = [
    { name: "Jordan Spackman", email: "info@realtourpilot.com", role: Role.ADMIN, avatarColor: "#4f46e5" },
    { name: "Kyle", email: "kyle@realtourpilot.com", role: Role.MANAGER, avatarColor: "#0ea5e9" },
    { name: "Maya Torres", email: "maya@realtourpilot.com", role: Role.PHOTOGRAPHER, avatarColor: "#8b5cf6" },
    { name: "Devin Park", email: "devin@realtourpilot.com", role: Role.PHOTOGRAPHER, avatarColor: "#ec4899" },
    { name: "Sam Rivera", email: "sam@realtourpilot.com", role: Role.EDITOR, avatarColor: "#d97706" },
    { name: "Lena Cho", email: "lena@realtourpilot.com", role: Role.EDITOR, avatarColor: "#f59e0b" },
    { name: "Ana (VA)", email: "ana@realtourpilot.com", role: Role.VA, avatarColor: "#16a34a" },
  ];
  for (const t of team) {
    await prisma.teamMember.upsert({ where: { email: t.email }, create: t, update: t });
  }

  console.log("Clean seed: resources…");
  const resourceCount = await prisma.resource.count();
  if (resourceCount === 0) {
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
  }

  console.log("Clean seed: SOPs…");
  const sopCount = await prisma.sop.count();
  if (sopCount === 0) {
    await prisma.sop.createMany({
      data: [
        { category: "Shooting", title: "Standard photo shoot checklist", summary: "Pre-shoot prep through on-site capture", content: "1. Confirm address, gate/lockbox code, and parking the day before.\n2. Arrive 10 min early; introduce yourself to the seller/agent.\n3. Lights on, blinds open, toilet lids down, cars out of driveway.\n4. Shoot wide-to-detail, every room + key exterior angles.\n5. Bracket exteriors for sky recovery.\n6. Upload same day via the Upload Portal and leave editor notes." },
        { category: "Shooting", title: "Twilight & drone add-ons", summary: "When the order includes twilight or aerial", content: "Twilight: arrive 45 min before sunset, scout angles in daylight, capture the 20-min golden window.\nDrone: check LAANC airspace authorization, charge 2+ batteries, keep VLOS, avoid neighbors' yards." },
        { category: "Editing", title: "House editing standard", summary: "Our baseline look for every gallery", content: "Bright & airy, true-to-life color, straight verticals always.\nSky replacement only when bracketed and natural-looking.\nMatch each client's saved editing preferences (see their CRM profile).\nDeliver MLS-sized + full-res sets." },
        { category: "Delivery", title: "Delivery & feedback flow", summary: "From QC to client gallery", content: "1. Manager QC pass: verticals, color, count, special requests met.\n2. Deliver gallery link via Aryeo + branded email.\n3. Mark project Delivered in the pipeline.\n4. VA sends a feedback/review request 24h later." },
        { category: "Sales", title: "New client intro call", summary: "How we talk to a prospective agent", content: "Goal: understand their volume, style, and pain points.\n- Ask what they shoot now and what frustrates them.\n- Lead with turnaround speed and consistency.\n- Quote packages clearly; note add-ons.\n- Book their first shoot on the call if possible." },
      ],
    });
  }

  const counts = {
    team: await prisma.teamMember.count(),
    resources: await prisma.resource.count(),
    sops: await prisma.sop.count(),
    clients: await prisma.client.count(),
    projects: await prisma.project.count(),
  };
  console.log("Clean seed done:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
