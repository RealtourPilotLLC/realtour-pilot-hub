// ---------------------------------------------------------------------------
// DRILL: WHAT THE POSITIVE-EVIDENCE RULE CHANGES (Sep 21 2026, third pass).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/attribution-rails.ts
//
// The react-server condition is not optional: commSenders.ts and openphone.ts
// both open with `import "server-only"`, which throws on sight without it.
//
// The first pass attributed outbound texts straight from OpenPhone's `userId`.
// The second pass made four send rails stamp the signed-in actor instead, and
// the reviewers then found SEVEN MORE rails doing the same unguarded thing. So
// the rule moved into the resolver, where it no longer needs a rail's
// cooperation, and it is now stated as evidence rather than as hope:
//
//   · an echo carrying somebody OTHER than the API key's owner is proof. The key
//     can only ever send as its owner, so Kyle's OpenPhone id on a message means
//     Kyle's handset typed it. Attribute it.
//   · an echo carrying THE KEY OWNER'S id proves nothing. Jordan typing on his
//     handset and the hub sending for Kyle are the same bytes to OpenPhone.
//     Refuse it, and let a session, an outbox row or a pre-existing CommLog row
//     be the thing that names a person.
//
// This drill replays BOTH rules over the real production rows of the last 30
// days, prints who ends up named, and prints the cost honestly: the rows that
// STOP carrying a name, split into the ones we can prove were hub sends and the
// ones that may genuinely be Jordan's own handset.
//
// READ-ONLY, STRUCTURALLY — see makeTheDatabaseReadOnly below. The previous
// version of this drill claimed "wrote nothing" and then wrote an AppSetting row
// through resolveSenderTeamMemberId -> senderMap() -> rebuild() -> putSetting,
// three calls deep, which is exactly how a good-faith claim goes wrong. A
// promise about what this file calls is worth nothing next to a connection that
// cannot execute an INSERT, so the guard is now the connection itself, and the
// drill proves it before it does anything else.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

/**
 * THE GUARD. Postgres refuses every write on this connection (SQLSTATE 25006),
 * however deep the call stack goes and whichever module opened it. It is
 * installed before the first dynamic import below, because src/lib/prisma builds
 * its client at module load and reads DATABASE_URL then.
 *
 * Prisma self-loads .env, so DATABASE_URL is usually absent from the process
 * environment at this point and we have to read it ourselves. dotenv is not
 * imported on purpose: it is a transitive dependency, not a declared one, and a
 * safety guard must not rest on somebody else's package tree.
 */
function makeTheDatabaseReadOnly(): void {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const candidates = [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../../.env")];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
      if (m) {
        url = m[1].trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}
makeTheDatabaseReadOnly();

const DAYS = 30;

type Payload = { userId: string; direction: string; from: string; arrivedAt: Date; eventType: string };

const pad = (n: number) => String(n).padStart(4);

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { ourOpenPhoneNumberKeys, phoneKey, OpenPhone } = await import("../../src/lib/integrations/openphone");
  const {
    payloadIsAttributable,
    isAttributableSource,
    echoIdentifiesAuthor,
    pickApiKeySenderUserId,
    matchOpUsers,
    HUB_SENT_SENDER_ID,
  } = await import("../../src/lib/commSenders");

  // ---- prove the guard before trusting anything else in this file ----------
  // An UPDATE whose WHERE matches nothing: Postgres still refuses it in a
  // read-only transaction, and if the guard were ever broken it would change no
  // row. The one probe that is safe whether or not it is needed.
  let guard = "NOT PROVEN";
  try {
    await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } });
  } catch (e) {
    guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN";
  }
  console.log(`=== READ-ONLY GUARD: ${guard} ===`);
  if (guard !== "PROVEN") {
    console.error("  The connection accepted a write. Refusing to run against production.");
    process.exitCode = 1;
    return;
  }

  const since = new Date(Date.now() - DAYS * 86_400_000);
  const line = await ourOpenPhoneNumberKeys();

  // Names WITHOUT the live resolver. resolveSenderTeamMemberId goes through
  // senderMap() -> rebuild() -> putSetting, which is the write the last review
  // caught. matchOpUsers is the same matching rule with no I/O, run against a
  // roster this drill fetched itself.
  const team = await prisma.teamMember.findMany({ select: { id: true, name: true, email: true } });
  const nameById = new Map(team.map((t) => [t.id, t.name]));
  const opUsers = await OpenPhone.users().catch(() => []);
  const { byUserId, labels } = matchOpUsers(opUsers, team);
  const who = (uid: string): string => {
    const tm = byUserId[uid];
    if (tm) return nameById.get(tm) ?? tm;
    return `UNRESOLVED(${labels[uid] ?? uid})`;
  };

  // ---- the retained payloads, keyed by provider message id -----------------
  const events = await prisma.webhookEvent.findMany({
    where: { provider: "openphone", createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { eventType: true, createdAt: true, payload: true },
  });
  const byMessageId = new Map<string, Payload>();
  for (const ev of events) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(ev.payload ?? "{}") as Record<string, unknown>; } catch { continue; }
    const d = ((p.data as Record<string, unknown>)?.object ?? p.data ?? p) as Record<string, unknown>;
    const id = typeof d.id === "string" ? d.id : "";
    if (!id || byMessageId.has(id)) continue; // earliest event for this message wins
    byMessageId.set(id, {
      userId: typeof d.userId === "string" ? d.userId.trim() : "",
      direction: String(d.direction ?? ""),
      from: phoneKey(String(d.from ?? "")),
      arrivedAt: ev.createdAt,
      eventType: ev.eventType ?? "",
    });
  }

  // ---- the outbox: every message the hub queued and sent itself -------------
  const outbox = await prisma.outboxMessage.findMany({
    where: { providerId: { not: null } },
    select: { providerId: true, requestedBy: true },
  });
  const outboxIds = new Set(outbox.map((o) => o.providerId).filter((v): v is string => !!v));
  const requestedBy = new Map<string, string>();
  for (const o of outbox) if (o.providerId) requestedBy.set(o.providerId, o.requestedBy ?? "(not recorded)");

  // ---- WHO DOES THE API KEY SEND AS -----------------------------------------
  // The shipped pure picker, over evidence this drill fetched itself. Every
  // outbox-backed echo agreeing on one id IS the proof that id belongs to the
  // key and not to an author.
  const echoes = [...byMessageId].map(([messageId, p]) => ({ messageId, userId: p.userId, direction: p.direction }));
  const keyOwner = pickApiKeySenderUserId(echoes, outboxIds);
  const keyEchoTally = new Map<string, number>();
  for (const e of echoes) {
    if (!outboxIds.has(e.messageId) || !e.direction.toLowerCase().startsWith("out") || !e.userId) continue;
    keyEchoTally.set(e.userId, (keyEchoTally.get(e.userId) ?? 0) + 1);
  }
  console.log("\n=== WHO THE API KEY SENDS AS (derived, not assumed) ===");
  for (const [uid, n] of [...keyEchoTally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(n)}  outbox-backed outgoing echoes carry ${uid} (${who(uid)})`);
  }
  console.log(`  → the key sends as: ${keyOwner ? `${keyOwner} (${who(keyOwner)})` : "UNKNOWN — the echo then names nobody at all"}`);

  // ---- the outbound texts of the window -------------------------------------
  const rows = await prisma.commLog.findMany({
    where: { channel: "text", direction: "out", occurredAt: { gte: since }, externalId: { startsWith: "op-" } },
    select: { id: true, externalId: true, source: true, createdAt: true, senderTeamMemberId: true, senderUserId: true },
    orderBy: { occurredAt: "asc" },
  });

  // ---- replay ---------------------------------------------------------------
  const oldSays = new Map<string, number>();
  const newSays = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const MACHINE = "nobody (machine source)";
  const HUB_COMPOSED = "nobody (the hub composed it: an outbox row)";
  const NO_PAYLOAD = "nobody (no trusted payload)";
  const AMBIGUOUS = "nobody (ambiguous: the API key's own id)";

  let machine = 0;
  let hubComposed = 0;
  let handsetNamed = 0;
  let alreadySettled = 0;
  // The cost, split by whether we can independently prove the old name was wrong.
  let lostNameProvenHubSend = 0;
  let lostNameMaybeHisHandset = 0;
  const lostNameBy = new Map<string, number>();
  const outboxSources = new Map<string, number>();
  const outboxRequesters = new Map<string, number>();

  for (const r of rows) {
    const providerId = r.externalId!.replace(/^op-/, "");
    const p = byMessageId.get(providerId);
    const inOutbox = outboxIds.has(providerId);
    // Only a hub rail can log a text before the provider has told us about it.
    const loggedBeforeEcho = !!p && r.createdAt.getTime() < p.arrivedAt.getTime();
    if (r.senderUserId === HUB_SENT_SENDER_ID) alreadySettled++;
    if (inOutbox) {
      bump(outboxSources, r.source ?? "(null)");
      bump(outboxRequesters, requestedBy.get(providerId) ?? "(not recorded)");
    }

    const gate =
      !!p &&
      payloadIsAttributable({
        eventType: p.eventType,
        direction: p.direction,
        fromWorkspaceLine: line.has(p.from),
        senderUserId: p.userId,
        messageId: providerId,
      });

    // WHAT THE OLD RULE SAID. The SOURCE allow-list is tested FIRST, before the
    // outbox — the previous version of this drill had it the other way round and
    // therefore credited the fix with 18 rows that the allow-list had always
    // refused anyway. An overstated proof is worse than a modest one.
    let oldLabel: string;
    if (!isAttributableSource(r.source)) oldLabel = MACHINE;
    else if (inOutbox) oldLabel = HUB_COMPOSED;
    else if (gate && p) oldLabel = who(p.userId);
    else oldLabel = NO_PAYLOAD;

    // WHAT THE NEW RULE SAYS: the same, plus the echo may not name the key's own
    // owner without separate evidence.
    let newLabel: string;
    if (!isAttributableSource(r.source)) { machine++; newLabel = MACHINE; }
    else if (inOutbox) { hubComposed++; newLabel = HUB_COMPOSED; }
    else if (gate && p && echoIdentifiesAuthor(p.userId, keyOwner)) { handsetNamed++; newLabel = who(p.userId); }
    else if (gate && p && p.userId && p.userId === keyOwner) {
      newLabel = AMBIGUOUS;
      bump(lostNameBy, oldLabel);
      if (loggedBeforeEcho) lostNameProvenHubSend++;
      else lostNameMaybeHisHandset++;
    } else newLabel = NO_PAYLOAD;

    bump(oldSays, oldLabel);
    bump(newSays, newLabel);
  }

  // ---- report ---------------------------------------------------------------
  console.log(`\n=== OUTBOUND TEXTS WITH A PROVIDER ID, LAST ${DAYS} DAYS ===`);
  console.log(`  rows examined: ${rows.length}`);
  console.log(`  retained payloads in the window: ${byMessageId.size}`);
  console.log(`  outbox rows with a provider id (all time): ${outboxIds.size}`);

  console.log("\n=== WHAT THE OLD RULE SAID ===");
  for (const [k, v] of [...oldSays].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(v)}  ${k}`);

  console.log("\n=== WHAT THE NEW RULE SAYS ===");
  for (const [k, v] of [...newSays].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(v)}  ${k}`);

  console.log("\n=== THE COST, STATED HONESTLY ===");
  const lost = lostNameProvenHubSend + lostNameMaybeHisHandset;
  console.log(`  ${lost} rows stop carrying a name, and every one of them carried the same name:`);
  for (const [k, v] of [...lostNameBy].sort((a, b) => b[1] - a[1])) console.log(`    ${pad(v)}  was: ${k}`);
  console.log(`  ${lostNameProvenHubSend} were logged BEFORE the provider's echo arrived, which only a hub rail`);
  console.log(`    can do, so for those the old name was provably the key's owner and not the author.`);
  console.log(`  ${lostNameMaybeHisHandset} show no such evidence, so they may genuinely be his own`);
  console.log(`    handset. Those are the real cost: his texts from the line are now UNKNOWN.`);
  console.log(`  That is the trade taken deliberately. He is not the one being coached, and a`);
  console.log(`  wrong name is worse than no name. Before this feature every one of these rows`);
  console.log(`  said "Us" and claimed nothing.`);
  console.log(`  Still named, and this is where the volume is: ${handsetNamed} rows.`);
  for (const [k, v] of [...newSays].filter(([k]) => !k.startsWith("nobody")).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(v)}  ${k}`);
  }

  const outboxInWindow = [...outboxSources.values()].reduce((a, b) => a + b, 0);
  console.log("\n=== CORRECTING THE PREVIOUS HEADLINE ===");
  console.log(`  The last pass claimed 18 rows moved off "the presser, on the hub's own template"`);
  console.log(`  and headlined "19 rows move off a false or manufactured name". Both were wrong,`);
  console.log(`  because that drill tested the outbox BEFORE the source allow-list. This window`);
  console.log(`  holds ${outboxInWindow} outbox rows and ${hubComposed} of them reach the outbox branch at all: every one`);
  console.log(`  carries a machine source the allow-list had always refused, so they said "nobody"`);
  console.log(`  before the change and "nobody" after it.`);
  console.log("  outbox rows in the window, by CommLog source:");
  for (const [k, v] of [...outboxSources].sort((a, b) => b[1] - a[1])) console.log(`    ${pad(v)}  ${k}`);
  console.log("  outbox rows in the window, by who asked for the send:");
  for (const [k, v] of [...outboxRequesters].sort((a, b) => b[1] - a[1])) console.log(`    ${pad(v)}  ${k}`);
  console.log("  Not one was a human pressing Send, so the tasks-panel change is preventive,");
  console.log("  not corrective. Net rows moved off a wrong name by that change: 0.");

  // ---- THE OTHER BLOCKING DEFECT: THE /shoot STATUS TEMPLATE ---------------
  // sendShootStatusText used to decide authorship with `edited ? "the person" :
  // "the hub"`, which can never choose "the hub" — ShootScreen prefills the
  // sheet with the exact template and hands the same string back. So a tapped
  // "On my way" was recorded as the photographer's own writing. This counts how
  // many rows on file are byte-identical to the template our own code renders
  // for that project: those are the ones that used to be his words and are now
  // correctly the hub's.
  const { shootStatusText } = await import("../../src/lib/statusTexts");
  const shootRows = await prisma.commLog.findMany({
    where: {
      channel: "text",
      direction: "out",
      projectId: { not: null },
      occurredAt: { gte: new Date(Date.now() - 180 * 86_400_000) },
      OR: [{ body: { contains: "with RealTour Pilot." } }, { body: { contains: "All wrapped up at" } }],
    },
    select: { body: true, projectId: true, source: true },
  });
  const projectIds = [...new Set(shootRows.map((r) => r.projectId!).filter(Boolean))];
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, title: true, client: { select: { name: true } }, photographer: { select: { name: true } } },
      })
    : [];
  const projectById = new Map(projects.map((p) => [p.id, p]));
  let templateExact = 0;
  let templateEdited = 0;
  for (const r of shootRows) {
    const p = projectById.get(r.projectId!);
    if (!p) continue;
    const ctx = { clientName: p.client.name, propertyTitle: p.title, photographerName: p.photographer?.name };
    const hit = (["on_my_way", "arrived", "complete"] as const).some((k) => shootStatusText(k, ctx) === (r.body ?? "").trim());
    if (hit) templateExact++;
    else templateEdited++;
  }
  console.log("\n=== THE /shoot STATUS TEMPLATE, ON REAL ROWS ===");
  console.log(`  status-shaped outbound texts on a project, last 180 days: ${shootRows.length}`);
  console.log(`  ${pad(templateExact)}  byte-identical to the template this code renders for that project`);
  console.log(`    → used to be recorded as the photographer's own writing; now "the hub", uncoachable.`);
  console.log(`  ${pad(templateEdited)}  differ from the template, so somebody really did type something`);
  console.log(`    → still "the person", which is the whole point of comparing rather than guessing.`);

  console.log("\n=== INVARIANTS ===");
  const kyle = Object.keys(byUserId).find((u) => u !== keyOwner) ?? "";
  const t = (label: string, got: boolean, want: boolean) =>
    console.log(`  ${got === want ? "ok  " : "FAIL"}  ${label} → ${got} (must be ${want})`);
  t(`echoIdentifiesAuthor("${kyle}" = ${kyle ? who(kyle) : "?"}, keyOwner)`, echoIdentifiesAuthor(kyle, keyOwner), true);
  t(`echoIdentifiesAuthor(keyOwner, keyOwner)`, echoIdentifiesAuthor(keyOwner, keyOwner), false);
  t(`echoIdentifiesAuthor("${kyle}", null)  // key owner not yet known`, echoIdentifiesAuthor(kyle, null), false);
  t(`echoIdentifiesAuthor("${HUB_SENT_SENDER_ID}", keyOwner)`, echoIdentifiesAuthor(HUB_SENT_SENDER_ID, keyOwner), false);
  t(`echoIdentifiesAuthor("", keyOwner)`, echoIdentifiesAuthor("", keyOwner), false);
  t(`pickApiKeySenderUserId([], outbox) // no evidence`, pickApiKeySenderUserId([], outboxIds) === null, true);
  t(
    `pickApiKeySenderUserId(two disagreeing ids) // never guesses`,
    pickApiKeySenderUserId(
      [
        { messageId: [...outboxIds][0] ?? "x", userId: "USaaaaaaaa", direction: "outgoing" },
        { messageId: [...outboxIds][1] ?? "y", userId: "USbbbbbbbb", direction: "outgoing" },
      ],
      outboxIds,
    ) === null,
    true,
  );

  const stray = await prisma.commLog.count({
    where: { senderUserId: HUB_SENT_SENDER_ID, senderTeamMemberId: { not: null }, source: { not: "openphone" } },
  });
  console.log(`  rows already carrying the hub-sent sentinel: ${alreadySettled}`);
  console.log(`  sentinel rows on a non-openphone source: ${stray} (must be 0)`);
  console.log(
    `  outbound texts still unattributed (null = UNKNOWN, never "nobody"): ${await prisma.commLog.count({ where: { channel: "text", direction: "out", senderTeamMemberId: null } })}`,
  );
  console.log(`  machine-source rows the allow-list refuses outright: ${machine}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
