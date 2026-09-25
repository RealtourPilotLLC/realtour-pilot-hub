// ---------------------------------------------------------------------------
// WHAT THE ISOLATED DEMO DATABASE HOLDS, AND THE LINKS INTO IT.
//
// Shared by the runner (scripts/demo/isolated-demo.ts) and its smoke drill
// (scripts/_drill/demo-smoke.ts) so the drill checks the very seeding Jordan
// clicks through, not a copy of it. No side effects at import; every function
// takes the caller's prisma, because this module loads before the database is
// pointed anywhere (same rule as scripts/_drill/_fixtures/contentMonth.ts).
//
// THE SHAPE. Three TEST clients, each built the way create-test-client.ts
// builds one — Client (staff-controlled plus-address, auto texts OFF) → ACTIVE
// ContentEnrollment on its package → this month → a portal link → an OWNER seat
// — by the drills' own fixture (buildContentMonth), then handed to E1's
// representative month (scripts/_fixtures/representativeMonth.ts,
// seedRepresentativeMonth(prisma, {clientId, monthKey, tier: "full", variant}))
// for everything a month contains: strategy, topics, scripts, sessions, the
// project and its cuts in every review state, last month's library.
//
//   accelerator  "Avery Accelerator TEST"  the current month in every state
//   pro          "Parker Pro TEST"         two sessions this month
//   ended        "Morgan Ended TEST"       an ended account, library intact
//
// Plus what only a demo needs: Jordan's staff login (OWNER, password in
// demo-config.json), the portal contact AppSetting (Kyle), and a dummy "ai"
// connection so the app's AI paths run into the demo fence's stub model
// instead of stopping at "AI is not connected".
//
// If E1's module is not in the tree, the clients still exist with their empty
// month and the runner says so loudly; nothing here restates E1's states.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import config from "./demo-config.json";
import { DEMO_CLIP_URL, demoClipUrlFor, isDemoClipUrl, DEMO_CLIP_PREFIX } from "./sample";

export type DemoVariant = "accelerator" | "pro" | "ended";

export const DEMO_CLIENTS: readonly { variant: DemoVariant; name: string; owner: string; package: "Accelerator" | "Pro"; slug: string; shows: string }[] = [
  { variant: "accelerator", name: "Avery Accelerator TEST", owner: "Avery Accelerator", package: "Accelerator", slug: "demoaccelerator", shows: "the current month in every state" },
  { variant: "pro", name: "Parker Pro TEST", owner: "Parker Pro", package: "Pro", slug: "demopro", shows: "a Pro month with two filming sessions" },
  { variant: "ended", name: "Morgan Ended TEST", owner: "Morgan Ended", package: "Accelerator", slug: "demoended", shows: "an ended account whose library stays open" },
];

/** A staff-controlled plus-address on Jordan's own inbox — the only kind assertTestDestinations accepts. */
export const demoEmail = (slug: string) => `info+${slug}test@realtourpilot.com`;

/** The AppSetting that says this database has been seeded, and with what. */
export const DEMO_SEED_KEY = "demo:isolated-seed";
/** Kyle, the office line — Jordan's decision for anything inside 24 hours. */
export const DEMO_PORTAL_CONTACT = { name: "Kyle", phoneE164: "+12156454889", display: "(215) 645-4889" };

/** What E1 reports back about the month it built — only the ids the links and the smoke drill use. */
export type DemoMonthRefs = {
  monthId: string | null;
  lastMonthId: string | null;
  projectId: string | null;
  lastProjectId: string | null;
  /** A awaiting the client · B sent back · B2 its round 2, in the Review Room · C approved · D delivered · last: last month's. */
  cuts: { A: string; B: string; B2: string; C: string; D: string; last: string[] } | null;
  topics: Record<string, string>;
  scripts: Record<string, string>;
  sessionRequestIds: string[];
  /** How many rows the fixture wrote on this run. */
  wrote: number;
};

export type DemoClientSeed = {
  variant: DemoVariant;
  name: string;
  clientId: string;
  enrollmentId: string;
  monthId: string;
  membershipId: string | null;
  portalToken: string;
  ownerEmail: string;
  month: DemoMonthRefs | null;
};

export type RepresentativeStatus = "seeded" | "missing" | `failed: ${string}`;

export type DemoSeed = {
  seededAt: string;
  monthKey: string;
  staffUserId: string;
  clients: DemoClientSeed[];
  /** Per variant: did E1's representative month land? */
  representative: Record<DemoVariant, RepresentativeStatus>;
};

type SeedFn = (prisma: PrismaClient, opts: { clientId: string; monthKey: string; tier: "full"; variant: DemoVariant; log?: (line: string) => void }) => Promise<unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strMap = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string") as [string, string][]) : {};

/** E1's RepresentativeResult, read field by field: a renamed field shows up as a missing link, never a crash. */
function monthRefsOf(r: unknown): DemoMonthRefs {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const c = o.cuts && typeof o.cuts === "object" ? (o.cuts as Record<string, unknown>) : null;
  const cuts = c && str(c.A) && str(c.B) && str(c.B2) && str(c.C) && str(c.D)
    ? { A: str(c.A)!, B: str(c.B)!, B2: str(c.B2)!, C: str(c.C)!, D: str(c.D)!, last: Array.isArray(c.last) ? c.last.filter((x): x is string => typeof x === "string") : [] }
    : null;
  return {
    monthId: str(o.monthId),
    lastMonthId: str(o.lastMonthId),
    projectId: str(o.projectId),
    lastProjectId: str(o.lastProjectId),
    cuts,
    topics: strMap(o.topics),
    scripts: strMap(o.scripts),
    sessionRequestIds: Array.isArray(o.sessionRequestIds) ? o.sessionRequestIds.filter((x): x is string => typeof x === "string") : [],
    wrote: Array.isArray(o.wrote) ? o.wrote.length : 0,
  };
}

export const REPRESENTATIVE_MONTH_FILE = path.resolve(__dirname, "../_fixtures/representativeMonth.ts");

/**
 * E1's seeder, if it is in the tree. Loaded by path rather than by a static
 * import so this file type-checks and runs before E1 lands; a module that is
 * present but does not export the documented function is reported, not guessed at.
 */
export async function loadRepresentativeMonth(): Promise<{ seed: SeedFn | null; why: string }> {
  if (!fs.existsSync(REPRESENTATIVE_MONTH_FILE)) return { seed: null, why: `${path.relative(process.cwd(), REPRESENTATIVE_MONTH_FILE)} is not in the tree yet` };
  const mod = (await import(REPRESENTATIVE_MONTH_FILE)) as { seedRepresentativeMonth?: unknown; default?: { seedRepresentativeMonth?: unknown } };
  const fn = mod.seedRepresentativeMonth ?? mod.default?.seedRepresentativeMonth;
  return typeof fn === "function" ? { seed: fn as SeedFn, why: "" } : { seed: null, why: "representativeMonth.ts does not export seedRepresentativeMonth" };
}

/** The one-time seed. Refuses anything but a loopback database, whatever called it. */
export async function seedDemo(prisma: PrismaClient, opts: { now?: Date; log?: (line: string) => void; verbose?: boolean } = {}): Promise<DemoSeed> {
  const log = opts.log ?? (() => {});
  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; } })();
  if (host !== "127.0.0.1") throw new Error(`refusing to seed the demo into ${host || "(no DATABASE_URL)"}: the demo database is always 127.0.0.1`);

  const { buildContentMonth } = await import("../_drill/_fixtures/contentMonth");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const { assertTestClient, assertTestDestinations } = await import("@/lib/testClients");
  const { hashPassword } = await import("@/lib/auth/password");
  const { encryptSecret } = await import("@/lib/integrations/crypto");
  const monthKey = etMonthKey(opts.now ?? new Date());

  // Staff first: E1's approvals and releases may want a person to attribute to.
  const staff = await prisma.appUser.upsert({
    where: { email: config.staffEmail },
    create: { email: config.staffEmail, name: config.staffName, role: "OWNER", status: "ACTIVE", passwordHash: await hashPassword(config.staffPassword) },
    update: { name: config.staffName, role: "OWNER", status: "ACTIVE", passwordHash: await hashPassword(config.staffPassword) },
    select: { id: true },
  });
  await prisma.appSetting.upsert({
    where: { key: "portal-contact" },
    create: { key: "portal-contact", value: JSON.stringify(DEMO_PORTAL_CONTACT), updatedBy: "isolated-demo" },
    update: { value: JSON.stringify(DEMO_PORTAL_CONTACT), updatedBy: "isolated-demo" },
  });

  const clients: DemoClientSeed[] = [];
  for (const spec of DEMO_CLIENTS) {
    const email = demoEmail(spec.slug);
    assertTestDestinations({ email });
    const f = await buildContentMonth(prisma, {
      name: spec.name,
      package: spec.package,
      monthKey,
      // The month's shoot project is E1's to make (with its cuts); making one
      // here too would give the month two.
      project: false,
      owner: { email, name: spec.owner },
    });
    assertTestClient({ id: f.clientId, name: spec.name });
    // What create-test-client.ts writes on every run: the client's own address,
    // and the two auto-text switches OFF (both default TRUE in the schema).
    await prisma.client.update({ where: { id: f.clientId }, data: { email, autoConfirmationText: false, autoDeliveryText: false } });
    clients.push({ variant: spec.variant, name: spec.name, clientId: f.clientId, enrollmentId: f.enrollmentId, monthId: f.monthId, membershipId: f.membershipId, portalToken: f.portalToken!, ownerEmail: email, month: null });
    log(`  client     ${spec.name} (${spec.package})`);
  }

  const representative = { accelerator: "missing", pro: "missing", ended: "missing" } as Record<DemoVariant, RepresentativeStatus>;
  // E1 writes every cut's blobUrl from DEMO_CLIP_URL, read when its module
  // loads. Its default is a plain loopback URL, which the stream route's
  // blobFetchDecision refuses; the demo's Vercel-shaped one is what plays.
  process.env.DEMO_CLIP_URL = DEMO_CLIP_URL;
  const rep = await loadRepresentativeMonth();
  if (!rep.seed) log(`  WARNING    representative month not seeded — ${rep.why}. The clients exist with an empty month.`);
  for (const c of clients) {
    if (!rep.seed) continue;
    try {
      const result = await rep.seed(prisma, { clientId: c.clientId, monthKey, tier: "full", variant: c.variant, log: opts.verbose ? (l) => log(`             ${l.trim()}`) : undefined });
      c.month = monthRefsOf(result);
      representative[c.variant] = "seeded";
      log(`  month      ${c.name}: representative month seeded (${c.variant}, ${c.month.wrote} step(s))`);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
      representative[c.variant] = `failed: ${msg}`;
      log(`  FAILED     ${c.name}: representative month threw — ${msg}`);
    }
  }

  // A key that only the demo fence will ever see: the dev server's fence
  // answers api.anthropic.com itself, so this string is never sent anywhere.
  // Written AFTER the months: E1's fixture is built and drilled with no AI
  // connection, and with one present its real functions reach for the model
  // (this process's fence blocks them — 12 blocked calls the first time round).
  await prisma.connection.upsert({
    where: { provider: "ai" },
    create: { provider: "ai", status: "CONNECTED", secretEncrypted: encryptSecret(config.aiStubKey), accountLabel: "Demo stub model (no network)" },
    update: { status: "CONNECTED", secretEncrypted: encryptSecret(config.aiStubKey), accountLabel: "Demo stub model (no network)", lastError: null },
  });

  // The ended account ends through the ledgered action Kyle's button uses, if
  // the fixture left it running (it has to be ACTIVE while its library is made).
  const ended = clients.find((c) => c.variant === "ended")!;
  const endedNow = await prisma.contentEnrollment.findUnique({ where: { id: ended.enrollmentId }, select: { status: true } });
  if (endedNow?.status !== "ENDED") {
    const { setEnrollmentStatus } = await import("@/lib/enrollmentChanges");
    await setEnrollmentStatus(ended.enrollmentId, "ENDED", staff.id, "Isolated demo: an ended account with its library intact");
  }

  const seed: DemoSeed = { seededAt: new Date().toISOString(), monthKey, staffUserId: staff.id, clients, representative };
  await prisma.appSetting.upsert({
    where: { key: DEMO_SEED_KEY },
    create: { key: DEMO_SEED_KEY, value: JSON.stringify(seed), updatedBy: "isolated-demo" },
    update: { value: JSON.stringify(seed), updatedBy: "isolated-demo" },
  });
  return seed;
}

export async function readDemoSeed(prisma: PrismaClient): Promise<DemoSeed | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: DEMO_SEED_KEY } });
  if (!row) return null;
  try { return JSON.parse(row.value) as DemoSeed; } catch { return null; }
}

/** Every Project the demo clients own — the month shoots E1 made. */
export async function demoProjects(prisma: PrismaClient, seed: DemoSeed) {
  return prisma.project.findMany({
    where: { clientId: { in: seed.clients.map((c) => c.clientId) } },
    select: { id: true, clientId: true, title: true, status: true, contentMonthId: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Point every demo cut at the local clip. A cut whose bytes live anywhere else
 * — a Dropbox path, an invented URL, nothing — would play as an error, because
 * the demo server can reach neither Dropbox nor a real store. Only blobUrl
 * moves (the stream route serves blobUrl first); the identity a client decision
 * records is id + size + file name, so an approval made before this still
 * matches its cut (cutEntitlement.ts). Idempotent; demo clients only.
 */
export async function pointCutsAtSample(prisma: PrismaClient, seed: DemoSeed): Promise<number> {
  const projects = await demoProjects(prisma, seed);
  if (!projects.length) return 0;
  const cuts = await prisma.reviewSubmission.findMany({ where: { projectId: { in: projects.map((p) => p.id) } }, select: { id: true, blobUrl: true } });
  let moved = 0;
  for (const cut of cuts) {
    if (isDemoClipUrl(cut.blobUrl)) continue;
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { blobUrl: demoClipUrlFor(cut.id), blobPathname: `${DEMO_CLIP_PREFIX}/${cut.id}.mp4` } });
    moved++;
  }
  return moved;
}

export type DemoLink = { label: string; url: string };

export type DemoLinks = {
  base: string;
  staff: DemoLink[];
  clients: { variant: DemoVariant; name: string; shows: string; portal: string; ownerEmail: string; staff: DemoLink[]; representative: RepresentativeStatus }[];
};

export async function demoLinks(prisma: PrismaClient, seed: DemoSeed, base = `http://localhost:${config.devPort}`): Promise<DemoLinks> {
  // Any job the fixture made that its result did not name (a re-run, a renamed
  // field) is still listed, so no project is unreachable from the printout.
  const projects = await demoProjects(prisma, seed);
  return {
    base,
    staff: [
      { label: `Sign in as Jordan (${config.staffEmail} / ${config.staffPassword})`, url: `${base}/login` },
      { label: "Content program — every client's month", url: `${base}/content` },
      { label: "Review Room — cuts waiting on the office", url: `${base}/review` },
      { label: "Editing queue", url: `${base}/editing` },
      { label: "Program monitoring (switches, runs)", url: `${base}/content/monitoring` },
    ],
    clients: seed.clients.map((c) => {
      const m = c.month;
      const staff: DemoLink[] = [{ label: "Client file (workspace)", url: `${base}/content/${c.enrollmentId}` }];
      if (m?.projectId) {
        staff.push({ label: "This month's job", url: `${base}/projects/${m.projectId}` });
        if (m.cuts) staff.push({ label: "Review Room: video B, round 2 (after the client's change request)", url: `${base}/review/${m.projectId}?cut=${m.cuts.B2}` });
        staff.push({ label: "Editor's view of the job", url: `${base}/edit/${m.projectId}` });
      }
      if (m?.lastProjectId) staff.push({ label: "Last month's job (delivered)", url: `${base}/projects/${m.lastProjectId}` });
      const named = new Set([m?.projectId, m?.lastProjectId]);
      for (const p of projects.filter((x) => x.clientId === c.clientId && !named.has(x.id))) staff.push({ label: `Job: ${p.title ?? p.id}`, url: `${base}/projects/${p.id}` });
      return {
        variant: c.variant,
        name: c.name,
        shows: DEMO_CLIENTS.find((d) => d.variant === c.variant)?.shows ?? "",
        portal: `${base}/portal/${c.portalToken}`,
        ownerEmail: c.ownerEmail,
        staff,
        representative: seed.representative[c.variant],
      };
    }),
  };
}

/**
 * Fresh one-time sign-in links for each client's OWNER seat, through the same
 * mintLoginLink the staff card's "Get sign-in link" button calls (TEST clients
 * only while portal_login_email is off). Single use, 15 minutes.
 */
export async function mintDemoSignInLinks(prisma: PrismaClient, seed: DemoSeed): Promise<{ name: string; url: string; expiresAt: Date }[]> {
  const { mintLoginLink } = await import("@/lib/portalAccess");
  const out: { name: string; url: string; expiresAt: Date }[] = [];
  for (const c of seed.clients) {
    if (!c.membershipId) continue;
    const r = await mintLoginLink(c.membershipId, seed.staffUserId);
    out.push({ name: c.name, ...r });
  }
  return out;
}

export function formatLinks(links: DemoLinks, signIn: { name: string; url: string; expiresAt: Date }[] = []): string {
  const lines: string[] = [];
  lines.push("STAFF (the hub)");
  for (const s of links.staff) lines.push(`  ${s.label}\n    ${s.url}`);
  for (const c of links.clients) {
    lines.push("");
    lines.push(`${c.name} — ${c.shows}`);
    if (c.representative !== "seeded") lines.push(`  !! representative month: ${c.representative}`);
    lines.push(`  Client portal, the shared link (views; approving needs the owner signed in)\n    ${c.portal}`);
    const s = signIn.find((x) => x.name === c.name);
    if (s) lines.push(`  Sign in as the owner, ${c.ownerEmail} (one use, until ${s.expiresAt.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET)\n    ${s.url}`);
    for (const l of c.staff) lines.push(`  ${l.label}\n    ${l.url}`);
  }
  return lines.join("\n");
}
