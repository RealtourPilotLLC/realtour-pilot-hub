// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL · oct30-split-visits: A SPLIT SHOOT, EACH VISIT ITS OWN (Oct 30 2026).
//
// Jordan: "Can you please see why Harrison did not get any texts for Laura's
// appointment today, and also why the upload portal isnt showing it? Its a
// split appointment but there was an appointment today and one next week on
// wednesday."
//
//   §1 the notes (pure): an "Order Notes:" block written in paragraphs is read
//      whole, not cut at the first blank line (the brief said only "Split
//      Appointment Instructions"); a heading paragraph joins the next one
//   §2 whose part (pure): "For Harrison:" goes to Harrison's visit, "For
//      James:" to James's, the rest to both, a bare heading to nobody; a "For"
//      naming nobody on the job is ordinary text
//   §3 the upload list (pure): Harrison's visit files under today, James's
//      under his own Wednesday, the office under today; a one-visit job and a
//      split job with no visit this week file by shootDate as before
//   §4 the Dropbox folder: a split job whose first visit happened keeps its
//      folder when shootDate moves on; a plain reschedule still moves it
//
// ISOLATION: PGlite via the shared harness, every .env key blank, Dropbox and
// the connections store replaced in-process (nothing leaves).
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5733);

const RealDate = Date;
const SIM = RealDate.parse("2026-10-30T17:30:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;

installNextStubs();
const fence = fenceFetch();

// A Dropbox of folders by path, and every move asked of it.
const folders = new Set<string>();
const moves: { from: string; to: string }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/dropbox",
  (loaded) => {
    const m = loaded as Record<string, unknown> & { DropboxError: new (msg: string) => Error };
    const under = (p: string) => [...folders].filter((f) => f.toLowerCase().startsWith(`${p.toLowerCase()}/`) && !f.slice(p.length + 1).includes("/"));
    return {
      ...m,
      dropboxConfigured: () => true,
      dropboxListFolder: async (p: string) => {
        if (![...folders].some((f) => f.toLowerCase() === p.toLowerCase())) throw new m.DropboxError("path/not_found/");
        return under(p).map((f) => ({ tag: "folder", name: f.split("/").pop()! }));
      },
      dropboxMoveFolder: async (from: string, to: string) => {
        moves.push({ from, to });
        for (const f of [...folders]) if (f === from || f.startsWith(`${from}/`)) { folders.delete(f); folders.add(to + f.slice(from.length)); }
        return true;
      },
      dropboxCreateFolder: async (p: string) => { folders.add(p); return true; },
      dropboxCreateFolderMeta: async (p: string) => { folders.add(p); return { path: p }; },
    };
  },
);
interceptModule(
  (r) => r === "@/lib/integrations/connections",
  (loaded) => ({ ...(loaded as Record<string, unknown>), getSecret: async (provider: string) => (provider === "dropbox" ? "drill-token" : null) }),
);

const c = makeChecker();

// Paragraphs as Kyle types them into Aryeo (the shape of Laura's, not her words).
const DESCRIPTION = [
  "Order Notes:",
  "",
  "Split Appointment Instructions",
  "",
  "For Harrison: only drone photos and video today. The client has shots she wants; I'll add them once she sends them.",
  "",
  "She won't be home that day.",
  "",
  "For James: the rest of the shoot. The stagers finish Monday, so this part is later.",
  "",
  "Order Questions:",
  "Lockbox code? 1234",
].join("\n");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { parseShootBrief, cleanBrief } = await import("@/lib/shoot");
    const core = await import("@/lib/photographerBriefCore");
    const { listVisit } = await import("@/lib/visitSubmission");
    const { uploadWindowStart } = await import("@/lib/uploadHistory");
    const { ensureProjectFolders, projectFolderPaths } = await import("@/lib/dropboxFolders");

    c.head("1 · The notes are read whole");
    const notes = parseShootBrief(cleanBrief(DESCRIPTION))?.orderNotes ?? "";
    c.ok("the block runs past the first blank line", notes.includes("For Harrison") && notes.includes("For James") && notes.includes("won't be home"), JSON.stringify(notes.slice(0, 80)));
    c.ok("the questions are not part of it", !notes.includes("Lockbox"));
    const single = parseShootBrief("Order Notes:\nShoot the pool first.\n\nOrder Questions:\nGate code? 9")?.orderNotes;
    c.ok("a one-paragraph note reads as before", single === "Shoot the pool first.", JSON.stringify(single));
    const joined = core.sentencesOf("Access details:\n\nSide gate is open.");
    c.ok("a heading paragraph joins the paragraph after it", joined.length === 1 && joined[0].startsWith("Access details: Side gate"), JSON.stringify(joined));

    c.head("2 · Each visit gets its own part");
    const crew = ["Harrison Wells", "James Livingston"];
    const harrison = core.sentencesOf(core.orderNotesFor(notes, "Harrison Wells", crew));
    const james = core.sentencesOf(core.orderNotesFor(notes, "James Livingston", crew));
    c.ok("Harrison: the drone instruction", harrison.some((s) => /^Only drone photos and video/.test(s)), JSON.stringify(harrison));
    c.ok("Harrison: the shared line too", harrison.some((s) => /won't be home/.test(s)));
    c.ok("Harrison: not James's part", !harrison.some((s) => /stagers/.test(s)));
    c.ok("James: his part", james.some((s) => /stagers finish Monday/.test(s)), JSON.stringify(james));
    c.ok("James: not Harrison's", !james.some((s) => /drone/.test(s)));
    c.ok("nobody gets the bare heading", ![...harrison, ...james].some((s) => /^Split Appointment Instructions$/i.test(s)));
    const solo = core.orderNotesFor("For the drone shots, start at the creek.", "Harrison Wells", ["Harrison Wells"]);
    c.ok("a 'For' naming nobody on the job is ordinary text", solo === "For the drone shots, start at the creek.", JSON.stringify(solo));

    c.head("3 · The upload list files each visit under its own day");
    const now = new Date();
    const windowStart = uploadWindowStart(now);
    const today3pm = new Date("2026-10-30T15:00:00-04:00"), wed10am = new Date("2026-11-04T10:00:00-04:00");
    const split = [
      { startAt: today3pm, status: "SCHEDULED", assignedToId: "harrison" },
      { startAt: wed10am, status: "SCHEDULED", assignedToId: "james" },
    ];
    const h = listVisit(split, now, windowStart, "harrison");
    c.ok("Harrison: today's 3 PM visit, 1 of 2", h?.at.getTime() === today3pm.getTime() && h.n === 1 && h.of === 2, JSON.stringify(h));
    const j = listVisit(split, now, windowStart, "james");
    c.ok("James: his own Wednesday visit, 2 of 2", j?.at.getTime() === wed10am.getTime() && j.n === 2, JSON.stringify(j));
    const office = listVisit(split, now, windowStart, null);
    c.ok("the office: today's visit", office?.at.getTime() === today3pm.getTime(), JSON.stringify(office));
    c.ok("someone with no visit on it: the office's answer", listVisit(split, now, windowStart, "kyle")?.at.getTime() === today3pm.getTime());
    c.ok("a one-visit job: shootDate, as before", listVisit([split[0]], now, windowStart, "harrison") === null);
    const old = [{ startAt: new Date("2026-10-09T10:00:00-04:00"), status: "SCHEDULED", assignedToId: "harrison" }, split[1]];
    c.ok("a split job with no visit this week: shootDate (Upcoming), as before", listVisit(old, now, windowStart, null) === null);
    const cancelled = [{ ...split[0], status: "CANCELED" }, split[1]];
    c.ok("a cancelled visit does not count", listVisit(cancelled, now, windowStart, "harrison") === null);

    c.head("4 · The Dropbox folder stays put once a visit has happened");
    const client = await prisma.client.create({ data: { name: "Laura Drill" }, select: { id: true } });
    const mk = async (street: string, visits: Date[], shootDate: Date, recordedFor: Date) => {
      const base = { title: `${street}, Media, PA`, addressLine: street, shootDate: recordedFor, createdAt: new Date("2026-10-20T12:00:00-04:00"), client: { name: "Laura Drill" } };
      const recorded = projectFolderPaths(base).listing;
      for (const sub of ["", "/01-RAW-Photos", "/02-RAW-Video"]) folders.add(recorded + sub);
      const p = await prisma.project.create({
        data: { title: base.title, addressLine: street, clientId: client.id, status: "SCHEDULED", shootDate, createdAt: base.createdAt, dropboxFolder: recorded },
        select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, status: true, dropboxFolder: true, client: { select: { name: true } } },
      });
      let k = 0;
      for (const v of visits) await prisma.appointment.create({ data: { aryeoId: `sv-${street}-${++k}`, projectId: p.id, startAt: v, status: "SCHEDULED" } });
      return { p, recorded };
    };
    const laura = await mk("12 Creek Rd", [today3pm, wed10am], wed10am, today3pm);
    const r1 = await ensureProjectFolders(laura.p);
    c.ok("the split job's folder is kept", r1 === "exists" && moves.length === 0, `${r1}, moves ${JSON.stringify(moves)}`);
    c.ok("and still recorded where it was", (await prisma.project.findUnique({ where: { id: laura.p.id } }))?.dropboxFolder === laura.recorded);
    const moved = await mk("40 Mill Ln", [wed10am], wed10am, today3pm);
    const r2 = await ensureProjectFolders(moved.p);
    c.ok("a plain reschedule still moves the folder", r2 === "moved" && moves.length === 1 && moves[0].to.includes("/November/"), `${r2}, ${JSON.stringify(moves)}`);

    c.ok("nothing left the machine", fence.blocked.length === 0, JSON.stringify(fence.blocked.slice(0, 3)));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
