// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026): the info@ re-file, version 2.
//
// scripts/_live/oct22-info-mail-refile.ts (comms audit H2) found the info@
// emails the hub had filed to a client by a street or town name the mail
// happened to contain (the code that did it is fixed and live), and planned
// "no client, owner-only" for every one. That is wrong for real client mail:
// Kimberly Mazzenga is Gary Mercer Team staff and her mail about 512
// Firethorn Rd and 1741 Hilltop Rd (Mike Flatley's jobs) sat on Marcee
// McMullen; Arielle Roemer is a client herself; Katie Brunner is Ashley
// Brunner's team. Version 2 decides each row by WHO SENT IT:
//
//   MOVE    the sender is a known client or contact, read in this order:
//             1. the address (a client's email or backup email, or a synced
//                contact's email that belongs to a client);
//             2. the name on the mail (a client's or such a contact's first
//                and last name, mailMatch.sameSenderName);
//             3. the company domain (not a free mailbox, not a vendor's): the
//                one client who owns it, or, when several of a team's
//                clients do, the one whose own job the mail names.
//           An assistant folds onto their agent (parentClientId), as the
//           Gmail scan does. The row goes on that client's job when the mail
//           names one of the client's OWN jobs, house number and street
//           together ("512 Firethorn"), else on the client with no job.
//   OWNER   personal or vendor mail (banks, Apple, HBO, Instagram, insurance,
//           the Chamber, loan and financing offers, pitches, a prospect's
//           intro, family): no client, no job, owner-only.
//   LEAVE   anything else (a vendor writing about a client's job, a team
//           sender with no job named, an unknown sender): left as filed and
//           listed for review, with what the mail points at.
//   KEEP    the sender's own client and job already: nothing to change.
//
// Plus one named move (Jordan, Oct 23): Olivia Vecere's Oct 21 email "New
// construction videos for Sussex" (filed under Mike Flatley on 913 Lakeview
// Ct; her links open "1337 Carolannes Way - Premium Cinematic Film - Video
// 1/2") moves to Sharra Mercer's 1337 Carolannes Way job of Aug 18, and its
// open ask (on Mike Flatley, no job) moves there too. The app's own
// assignAskProject refuses another client's job (it keeps an ask on its own
// client); the ask moves with clientAsks.refileAskToClientJob, which exists
// for a misfiled message.
//
// The sender's address is read from Gmail (metadata only; nothing changes in
// Gmail). Nothing is sent. Tasks made from these emails are listed, not touched.
//
// Dry run (default; read-only database connection):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct23-info-mail-refile-v2.ts
// Write it:
//   ... scripts/_live/oct23-info-mail-refile-v2.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}
const INFO = "info@realtourpilot.com";
const BY = "info@ re-file v2 (Oct 23 2026)";
const OLIVIA_COMM = "cmvi9rekj0003l308tftoneum";
const OLIVIA_ASK = "cmvi9rnb10004l308yzogqqo7";
const SHARRA_SUSSEX = "cmsrlzhlj0036jx04r8sny19g";
const day = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Free mailboxes: a domain anyone can have, never a company. */
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "aol.com", "icloud.com", "me.com", "mac.com", "outlook.com", "live.com", "msn.com", "comcast.net", "verizon.net", "att.net", "ymail.com", "protonmail.com"]);

/** Personal or vendor mail: no client, owner-only. The address or its domain, and why. */
const PERSONAL_OR_VENDOR: { re: RegExp; why: string }[] = [
  { re: /@(?:[\w-]+\.)*greendot\.com$/i, why: "bank (Green Dot)" },
  { re: /@(?:[\w-]+\.)*apple\.com$/i, why: "Apple" },
  { re: /@(?:[\w-]+\.)*hbomax\.com$/i, why: "HBO Max" },
  { re: /@(?:[\w-]+\.)*instagram\.com$/i, why: "Instagram" },
  { re: /@bhi-insurance\.net$/i, why: "insurance quote" },
  { re: /@lancasterchamber\.com$/i, why: "the Lancaster Chamber" },
  { re: /@pmfus\.com$/i, why: "loan offer (line of credit)" },
  { re: /@crestoak\.co$/i, why: "loan offer" },
  { re: /@wayflyer\.com$/i, why: "financing offer (Wayflyer)" },
  { re: /@sterlingviewagency\.co$/i, why: "financing offer" },
  { re: /@(?:[\w-]+\.)*pa\.gov$/i, why: "PA tax notice" },
  { re: /@(?:[\w-]+\.)*zapier\.com$/i, why: "software sales (Zapier)" },
  { re: /@loneoaktherapeutic\.org$/i, why: "charity sponsorship ask" },
  { re: /@weassistlocaldistricts\.com$/i, why: "advertising pitch (school posters)" },
  { re: /@luxcofilms\.com$/i, why: "agency pitch" },
  { re: /@flylisted\.com$/i, why: "vendor pitch (Staffify / Flylisted)" },
  { re: /@realstudioz\.com$/i, why: "editing vendor pitch" },
  { re: /^growwtechimages@gmail\.com$/i, why: "editing vendor pitch" },
  { re: /^jaadii63@gmail\.com$/i, why: "editing vendor pitch (a freelance editor)" },
  { re: /^christianfl@zillowgroup\.com$/i, why: "Zillow sales (a quote that went elsewhere)" },
  { re: /^dhlipson@gmail\.com$/i, why: "a prospect's intro to Jordan (Hopeworks), not a client" },
  { re: /spackman/i, why: "family" },
];
/** A vendor writing about a client's job that the mail names: left on the job, listed for review. */
const VENDOR_ON_A_JOB: { re: RegExp; why: string }[] = [
  { re: /^3dhome@zillowgroup\.com$/i, why: "Zillow 3D support writing about this listing" },
  { re: /@beautiful-shots\.com$/i, why: "a subcontracted photographer's order for this listing" },
];

type Client = { id: string; name: string; email: string | null; backupEmail: string | null; parentClientId: string | null };
type Decision =
  | { action: "move"; clientId: string; clientName: string; projectId: string | null; projectTitle: string | null; how: string }
  | { action: "keep"; how: string }
  | { action: "owner"; how: string }
  | { action: "leave"; how: string; hint: string | null };

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { streetMatchAllowed, sameSenderName } = await import("@/lib/mailMatch");
  const { staffAddressBook, isStaffAddress } = await import("@/lib/staffEmail");
  const { gmailSenderAddresses } = await import("@/lib/integrations/google");
  if (streetMatchAllowed({ mailbox: INFO, senderKnown: false })) throw new Error("the code rule still allows the street match for unknown info@ senders: not refiling");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: info@ mail filed to a client by a street or town name, version 2 (by who sent it)\n`);

  // ---- the same rows as version 1 -------------------------------------------------------------
  const rows = await prisma.commLog.findMany({
    where: { channel: "email", direction: "in", externalId: { startsWith: `gmail-${INFO}:` }, clientId: { not: null }, projectId: { not: null }, projectGuess: false },
    orderBy: { occurredAt: "desc" },
    select: { id: true, externalId: true, clientId: true, clientName: true, contactName: true, subject: true, body: true, projectId: true, projectGuess: true, minRole: true, occurredAt: true },
  });
  const [clients, contacts, book] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true, email: true, backupEmail: true, parentClientId: true } }),
    prisma.contact.findMany({ where: { clientId: { not: null } }, select: { firstName: true, lastName: true, email: true, clientId: true } }),
    staffAddressBook(),
  ]);
  const byId = new Map<string, Client>(clients.map((c) => [c.id, c]));
  const fold = (id: string): Client => {
    const c = byId.get(id)!;
    return (c.parentClientId && byId.get(c.parentClientId)) || c;
  };
  const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  // Version 1's "known" (the scan's own lookup at the time): a client's email, or a contact's with a client.
  const scanKnown = new Set([...clients.filter((c) => c.email).map((c) => lc(c.email)), ...contacts.filter((c) => c.email).map((c) => lc(c.email))]);
  const senders = await gmailSenderAddresses(INFO, rows.map((r) => r.externalId!.slice(`gmail-${INFO}:`.length)));
  const fromOf = new Map<string, string>();
  const todo = rows.filter((r) => {
    const from = senders.get(r.externalId!.slice(`gmail-${INFO}:`.length));
    if (!from) return false;
    fromOf.set(r.id, lc(from));
    return !isStaffAddress(from, book) && !scanKnown.has(lc(from)) && !sameSenderName(r.contactName, r.clientName);
  });
  console.log(`rows version 1 re-files (a sender the scan did not know): ${todo.length}`);

  // ---- who sent it ----------------------------------------------------------------------------
  const domainOf = (a: string) => a.split("@")[1] ?? "";
  const clientsByAddress = new Map<string, Set<string>>();
  const addAddr = (a: string | null | undefined, clientId: string) => {
    if (!a) return;
    const s = clientsByAddress.get(lc(a)) ?? new Set<string>();
    s.add(fold(clientId).id);
    clientsByAddress.set(lc(a), s);
  };
  for (const c of clients) { addAddr(c.email, c.id); addAddr(c.backupEmail, c.id); }
  for (const k of contacts) addAddr(k.email, k.clientId!);
  const domainOwners = new Map<string, Set<string>>();
  for (const [a, ids] of clientsByAddress) {
    const d = domainOf(a);
    if (!d || FREE_MAIL.has(d)) continue;
    const s = domainOwners.get(d) ?? new Set<string>();
    ids.forEach((x) => s.add(x));
    domainOwners.set(d, s);
  }
  const named = (display: string | null): Set<string> => {
    const out = new Set<string>();
    for (const c of clients) if (sameSenderName(display, c.name)) out.add(fold(c.id).id);
    for (const k of contacts) if (sameSenderName(display, `${k.firstName ?? ""} ${k.lastName ?? ""}`)) out.add(fold(k.clientId!).id);
    return out;
  };
  // A job the mail NAMES: its house number and street together ("512 Firethorn",
  // "2 QUAIL RUN", "859 N Lawrence"), the subject first, newest order first.
  // Stricter than the street-word match that misfiled these rows ("Spring
  // City" is not 115 Spring Ln). In the body, an address that is a job of two
  // or more clients is not read: a team's office ("893 S. Matlack St" in every
  // Gary Mercer Team signature) names nobody's listing.
  const DIR = "(?:(?:n|s|e|w|north|south|east|west)\\.?\\s+)?";
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allJobs = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { id: true, title: true, addressLine: true, clientId: true },
  });
  const keyed = allJobs.flatMap((p) => {
    const m = new RegExp(`^(\\d+[a-z]?)\\s+${DIR}([a-z0-9'-]+)`, "i").exec((p.addressLine || p.title.split(",")[0]).trim());
    return m ? [{ ...p, key: `${m[1]} ${m[2]}`.toLowerCase(), re: new RegExp(`\\b${esc(m[1])}\\s+${DIR}${esc(m[2])}\\b`, "i") }] : [];
  });
  const clientsOfKey = new Map<string, Set<string>>();
  for (const p of keyed) clientsOfKey.set(p.key, (clientsOfKey.get(p.key) ?? new Set<string>()).add(fold(p.clientId!).id));
  const namedJob = (clientId: string, subject: string, body: string): { id: string; title: string } | null => {
    const mine = keyed.filter((p) => p.clientId === clientId || fold(p.clientId!).id === clientId);
    const s = subject.replace(/\s+/g, " ");
    const b = body.replace(/\s+/g, " ");
    return mine.find((p) => p.re.test(s)) ?? mine.find((p) => (clientsOfKey.get(p.key)?.size ?? 0) < 2 && p.re.test(b)) ?? null;
  };
  const clientsNamedInThread = (body: string): string[] => {
    const found = new Set<string>();
    for (const m of body.matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) for (const id of clientsByAddress.get(lc(m[0])) ?? []) found.add(byId.get(id)!.name);
    return [...found];
  };

  const decisions = new Map<string, Decision>();
  for (const r of todo) {
    const from = fromOf.get(r.id)!;
    const place = async (clientId: string, how: string): Promise<Decision> => {
      const c = byId.get(clientId)!;
      const job = namedJob(clientId, r.subject ?? "", r.body);
      if (clientId === r.clientId && (job?.id ?? null) === r.projectId) return { action: "keep", how: `${how}: already on ${c.name}${job ? `, ${job.title.split(",")[0]}` : ""}` };
      return { action: "move", clientId, clientName: c.name, projectId: job?.id ?? null, projectTitle: job?.title ?? null, how };
    };
    // 1. the address
    const byAddr = clientsByAddress.get(from);
    if (byAddr?.size === 1) { decisions.set(r.id, await place([...byAddr][0], `known address ${from}`)); continue; }
    // 2. the name on the mail
    const byName = named(r.contactName);
    if (byName.size === 1) { decisions.set(r.id, await place([...byName][0], `the name "${r.contactName}" is a client's`)); continue; }
    // Personal and vendor mail.
    const pv = PERSONAL_OR_VENDOR.find((x) => x.re.test(from) || (x.why === "family" && x.re.test(r.contactName ?? "")));
    if (pv) { decisions.set(r.id, { action: "owner", how: pv.why }); continue; }
    const vj = VENDOR_ON_A_JOB.find((x) => x.re.test(from));
    if (vj) {
      const job = r.clientId ? namedJob(r.clientId, r.subject ?? "", r.body) : null;
      decisions.set(r.id, { action: "leave", how: vj.why, hint: job && job.id !== r.projectId ? `the mail names ${job.title.split(",")[0]} (same client), not the job it is on` : null });
      continue;
    }
    // 3. the company domain
    const owners = domainOwners.get(domainOf(from));
    if (owners?.size === 1) { decisions.set(r.id, await place([...owners][0], `the domain ${domainOf(from)} is ${byId.get([...owners][0])!.name}'s`)); continue; }
    if (owners && owners.size > 1) {
      const hits: { clientId: string; job: { id: string; title: string } }[] = [];
      for (const id of owners) {
        const job = namedJob(id, r.subject ?? "", r.body);
        if (job) hits.push({ clientId: id, job });
      }
      if (hits.length === 1) { decisions.set(r.id, await place(hits[0].clientId, `a ${domainOf(from)} sender (${owners.size} clients on that team domain) about ${byId.get(hits[0].clientId)!.name}'s own job`)); continue; }
      decisions.set(r.id, { action: "leave", how: `a ${domainOf(from)} sender (${owners.size} clients on that team domain) and ${hits.length ? `jobs of ${hits.length} of them named` : "none of their jobs named"}`, hint: `team: ${[...owners].map((id) => byId.get(id)!.name).join(", ")}` });
      continue;
    }
    const thread = clientsNamedInThread(r.body);
    decisions.set(r.id, { action: "leave", how: byName.size > 1 ? `the name "${r.contactName}" fits ${byName.size} clients` : "an unknown sender, not a known vendor", hint: thread.length ? `clients on the thread: ${thread.join(", ")}` : null });
  }

  // A review hint for a row left as filed: the same subject from the same sender that does move.
  const subjectKey = (s: string | null) => (s ?? "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim().toLowerCase();
  for (const r of todo) {
    const d = decisions.get(r.id)!;
    if (d.action !== "leave") continue;
    const twin = todo.find((x) => x.id !== r.id && fromOf.get(x.id) === fromOf.get(r.id) && subjectKey(x.subject) === subjectKey(r.subject) && decisions.get(x.id)!.action === "move");
    if (!twin) continue;
    const t = decisions.get(twin.id) as Extract<Decision, { action: "move" }>;
    d.hint = `${d.hint ? `${d.hint}; ` : ""}the same thread's other mail moves to ${t.clientName}${t.projectTitle ? ` on ${t.projectTitle.split(",")[0]}` : ""}`;
  }

  // ---- print, grouped by what each row would become ----------------------------------------------
  const titles = new Map((await prisma.project.findMany({ where: { id: { in: [...new Set(todo.map((r) => r.projectId!))] } }, select: { id: true, title: true } })).map((p) => [p.id, p.title.split(",")[0]]));
  const line = (r: (typeof todo)[number]) => `${r.id} ${day(r.occurredAt)} from ${fromOf.get(r.id)} ("${r.contactName ?? "?"}") "${(r.subject ?? "").slice(0, 70)}"\n      now: ${r.clientName} on ${titles.get(r.projectId!) ?? r.projectId} [${r.minRole}]`;
  const group = (a: Decision["action"]) => todo.filter((r) => decisions.get(r.id)!.action === a);
  const moves = group("move");
  const owners = group("owner");
  const leaves = group("leave");
  const keeps = group("keep");
  console.log(`\nMOVE to the sender's client (${moves.length}):`);
  for (const r of moves) {
    const d = decisions.get(r.id) as Extract<Decision, { action: "move" }>;
    console.log(`  · ${line(r)}\n      → ${d.clientName}${d.projectTitle ? ` on ${d.projectTitle.split(",")[0]}` : " (no job: the mail names none of theirs)"} [${r.minRole}]   (${d.how})`);
  }
  console.log(`\nOWNER-ONLY: personal or vendor mail (${owners.length}):`);
  for (const r of owners) console.log(`  · ${line(r)}\n      → no client, no job [OWNER]   (${(decisions.get(r.id) as Extract<Decision, { action: "owner" }>).how})`);
  console.log(`\nLEAVE as filed, for review (${leaves.length}):`);
  for (const r of leaves) {
    const d = decisions.get(r.id) as Extract<Decision, { action: "leave" }>;
    console.log(`  · ${line(r)}\n      → unchanged   (${d.how}${d.hint ? `; ${d.hint}` : ""})`);
  }
  console.log(`\nKEEP: already the sender's own client and job (${keeps.length}):`);
  for (const r of keeps) console.log(`  · ${line(r)}\n      → unchanged   (${(decisions.get(r.id) as Extract<Decision, { action: "keep" }>).how})`);

  // ---- Olivia Vecere's Sussex email and its ask ----------------------------------------------------
  console.log("\nOLIVIA VECERE'S SUSSEX EMAIL (Jordan, Oct 23):");
  const oc = await prisma.commLog.findUnique({ where: { id: OLIVIA_COMM }, select: { id: true, clientId: true, clientName: true, projectId: true, projectGuess: true, minRole: true, subject: true, contactName: true, occurredAt: true } });
  const oa = await prisma.clientAsk.findUnique({ where: { id: OLIVIA_ASK }, select: { id: true, clientId: true, projectId: true, state: true, summary: true, holdsDelivery: true, medium: true } });
  const sj = await prisma.project.findUnique({ where: { id: SHARRA_SUSSEX }, select: { id: true, title: true, shootDate: true, status: true, clientId: true, client: { select: { name: true } } } });
  if (!oc || !oa || !sj?.clientId) throw new Error("Olivia's email, her ask or Sharra's 1337 Carolannes Way job is missing");
  const ocJob = oc.projectId ? (await prisma.project.findUnique({ where: { id: oc.projectId }, select: { title: true } }))?.title.split(",")[0] : null;
  const oaClient = byId.get(oa.clientId)?.name ?? oa.clientId;
  const olivia = clients.find((c) => c.name === "Olivia Vecere");
  console.log(`  · email ${oc.id} ${day(oc.occurredAt)} "${oc.subject}" from ${oc.contactName}\n      now: ${oc.clientName} on ${ocJob ?? "no job"}${oc.projectGuess ? " (guessed)" : ""} [${oc.minRole}]\n      → ${sj.client?.name} on ${sj.title.split(",")[0]} (Aug 18 2026 shoot, ${sj.status}) [${oc.minRole}]   (her links open "1337 Carolannes Way - Premium Cinematic Film - Video 1/2")`);
  console.log(`  · ask ${oa.id} [${oa.state}, ${oa.medium}, ${oa.holdsDelivery ? "holds delivery" : "does not hold"}] "${oa.summary}"\n      now: ${oaClient}, no job\n      → ${sj.client?.name} on ${sj.title.split(",")[0]}`);
  const { assignAskProject } = await import("@/lib/clientAsks");
  // The app's own "put on a job": read first, so on another client's job it answers before any write.
  const check = sj.clientId === oa.clientId ? null : await assignAskProject(OLIVIA_ASK, SHARRA_SUSSEX, BY).catch((e: unknown) => ({ ok: false, message: `error: ${(e as Error).message.split("\n")[0]}` }));
  console.log(`      assignAskProject (the app's "put on a job") on that job: ${check ? (check.ok ? "allowed" : `refused: "${check.message}"`) : "same client"}`);
  console.log("      so the ask moves with clientAsks.refileAskToClientJob (client and job together, the reason on its history and the job's timeline)");
  if (olivia?.parentClientId) console.log(`  NOT CHANGED HERE: Olivia Vecere's own client row (${olivia.id}) is filed under ${byId.get(olivia.parentClientId)?.name} (parentClientId). Until it is set to Sharra Mercer, her next email lands on ${byId.get(olivia.parentClientId)?.name} again.`);

  // ---- tasks made from the moved or owner-only rows: listed only ------------------------------------
  const touched = [...moves, ...owners];
  const tasks: string[] = [];
  for (const r of touched) {
    const subj = (r.subject ?? "").replace(/^(re|fwd?|fw)\s*:\s*/i, "").slice(0, 30);
    if (subj.length < 6) continue;
    const t = await prisma.smartTask.findMany({
      where: { clientId: r.clientId, source: { startsWith: "gmail" }, createdAt: { gte: new Date(r.occurredAt.getTime() - 60_000), lte: new Date(r.occurredAt.getTime() + 15 * 60_000) }, OR: [{ title: { contains: subj, mode: "insensitive" } }, { description: { contains: subj, mode: "insensitive" } }, { summary: { contains: subj, mode: "insensitive" } }] },
      select: { id: true, title: true, status: true },
    });
    for (const x of t) tasks.push(`${x.id} [${x.status}] "${x.title}" on ${r.clientName} (from ${r.id})`);
  }
  console.log(`\nTasks made from the rows that change (left as they are): ${tasks.length}`);
  for (const t of tasks) console.log(`  · ${t}`);
  console.log(`\nTOTAL: ${moves.length} move, ${owners.length} owner-only, ${leaves.length} left for review, ${keeps.length} already right; plus Olivia's email and ask.`);

  if (!APPLY) {
    console.log("\nNothing was written. Run with --apply to make these changes.");
    process.exit(0);
  }
  let moved = 0, privated = 0;
  for (const r of moves) {
    const d = decisions.get(r.id) as Extract<Decision, { action: "move" }>;
    const u = await prisma.commLog.updateMany({ where: { id: r.id, clientId: r.clientId, projectId: r.projectId }, data: { clientId: d.clientId, clientName: d.clientName, projectId: d.projectId, projectGuess: false } });
    moved += u.count;
  }
  for (const r of owners) {
    const u = await prisma.commLog.updateMany({ where: { id: r.id, clientId: r.clientId, projectId: r.projectId }, data: { clientId: null, clientName: null, projectId: null, projectGuess: false, minRole: "OWNER" } });
    privated += u.count;
  }
  const ou = await prisma.commLog.updateMany({ where: { id: OLIVIA_COMM, clientId: oc.clientId, projectId: oc.projectId }, data: { clientId: sj.clientId, clientName: sj.client?.name ?? null, projectId: SHARRA_SUSSEX, projectGuess: false } });
  const { refileAskToClientJob } = await import("@/lib/clientAsks");
  const ar = await refileAskToClientJob(OLIVIA_ASK, SHARRA_SUSSEX, BY, "Olivia Vecere is Sharra Mercer's assistant; her links open 1337 Carolannes Way, Premium Cinematic Film, Video 1 and 2.");
  console.log(`\nMoved ${moved} row(s), set ${privated} owner-only, Olivia's email ${ou.count ? "moved" : "changed meanwhile, left"}, her ask: ${ar.message}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
