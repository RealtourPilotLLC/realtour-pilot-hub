import "server-only";

import { prisma } from "@/lib/prisma";
import { dropboxCreateFolder, dropboxCreateFolderMeta, dropboxListFolder, dropboxMoveFolder, dropboxConfigured, DropboxError } from "@/lib/integrations/dropbox";
import { getSecret } from "@/lib/integrations/connections";
import { generateTasksForActiveProjects } from "@/lib/tasks";
import { isAutomationEnabled } from "@/lib/programAutomation";

// ---------------------------------------------------------------------------
// Mirrors the Zapier "AutoHDR" folder convention so the hub knows exactly where
// photographers/editors upload, and can drive status from file presence:
//   /AutoHDR/{Year}/{Quarter}/{Month}/{Street} ({Client})/
//     01-RAW-Photos · 02-RAW-Video · 03-Backup-Photos · 04-Final-Photos · 05-Final-Video
// (03-Backup-Photos added Aug 31 2026 — the culling standard's home for the
// extra frames; the Zap's original output had no 03, we fill the gap.)
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type ProjectFolders = {
  listing: string;
  rawPhotos: string;
  rawVideo: string;
  backupPhotos: string;
  finalPhotos: string;
  finalVideo: string;
};

export type FolderProject = {
  title: string;
  addressLine: string | null;
  shootDate: Date | null;
  createdAt: Date;
  client: { name: string };
  /** the folder the engine actually created/moved to, when it recorded one */
  dropboxFolder?: string | null;
};

// Year/month of a date IN EASTERN TIME. The Zap names folders by the shoot's
// local (ET) date; getFullYear()/getMonth() run in SERVER time — UTC on Vercel —
// so an ET evening shoot near a month/quarter boundary computed a DIFFERENT
// folder than the one the files actually live in, and every count read zero
// (July 2026 audit: "folder paths are guessed … UTC month boundary").
function etYearMonth(date: Date): { year: number; monthIdx: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((x) => x.type === "year")?.value ?? date.getFullYear());
  const monthIdx = Number(parts.find((x) => x.type === "month")?.value ?? date.getMonth() + 1) - 1;
  return { year, monthIdx };
}

// The street the folder is named after — the listing's address line, else the
// first comma-piece of the title.
function streetOf(p: Pick<FolderProject, "title" | "addressLine">): string {
  return (p.addressLine || p.title.split(",")[0] || "Listing").trim();
}

// "Sep 9" in ET — the disambiguator a same-street re-shoot's folder carries.
function etShortDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(date);
}

// Build the folder paths for a project following the Zap's naming.
export function projectFolderPaths(p: FolderProject): ProjectFolders {
  const date = p.shootDate ?? p.createdAt;
  const { year, monthIdx } = etYearMonth(date);
  const month = MONTHS[monthIdx];
  const quarter = `Q${Math.floor(monthIdx / 3) + 1}`;
  const listingName = `${streetOf(p)} (${p.client.name})`;
  const base = `/AutoHDR/${year}/${quarter}/${month}/${listingName}`;
  return foldersUnder(base);
}

// A same-street re-shoot's own listing name: the convention path with the ET
// shoot date appended — "1946 Rowan St (William Hannum) — Sep 9" — and a
// counter after that for two re-shoots on one day. Plain characters only
// (Dropbox rejects / \ : ? * < > " |, none of which can appear here), and the
// numbered subfolders hang under it exactly as they do under the plain name.
export function disambiguatedListingPath(plain: string, p: Pick<FolderProject, "shootDate" | "createdAt">, n = 1): string {
  const dated = `${plain} — ${etShortDate(p.shootDate ?? p.createdAt)}`;
  return n <= 1 ? dated : `${dated} (${n})`;
}

function foldersUnder(base: string): ProjectFolders {
  return {
    listing: base,
    rawPhotos: `${base}/01-RAW-Photos`,
    rawVideo: `${base}/02-RAW-Video`,
    backupPhotos: `${base}/03-Backup-Photos`,
    finalPhotos: `${base}/04-Final-Photos`,
    finalVideo: `${base}/05-Final-Video`,
  };
}

/**
 * Where this job's files ACTUALLY live. projectFolderPaths() returns the
 * CONVENTION path (year/quarter/month/street) — ensureProjectFolders compares
 * against it to detect a reschedule and move the folder, so it must keep
 * returning the convention. But every READ surface wants the real location:
 * a shoot moved August→September leaves the files in September while the
 * convention still says August, so the portal read an empty/absent folder and
 * told the photographer "the RAW-Video folder is empty" (Jordan, Sep 1 —
 * Harrison; 4 live jobs were mis-pointed, incl. 775 Scotch Way).
 */
export function actualFolderPaths(p: FolderProject): ProjectFolders {
  const base = p.dropboxFolder?.trim();
  return base ? foldersUnder(base) : projectFolderPaths(p);
}

// ---------------------------------------------------------------------------
// FOLDER ENGINE — the hub took this over from Zapier (Aug 2026, the Zap broke
// and new bookings stopped getting folders; the backfill sweep found ELEVEN
// upcoming shoots with no folder). Jordan's ask, beyond what the Zap did:
// "it doesn't change the folder location when it's rescheduled or canceled."
//
// So the engine has three moves, and Project.dropboxFolder is its memory —
// the Zap could never handle reschedules because nothing remembered where the
// folder was put:
//   CREATE   no folder anywhere → listing + the four numbered subfolders
//   MOVE     stored path ≠ path computed from the CURRENT shoot date (a
//            reschedule crossed a month/quarter/year) → files/move_v2, files
//            ride along
//   ARCHIVE  job cancelled with a folder → move under /AutoHDR/Canceled/{Year}/
//            — never delete; a cancelled shoot can carry uploaded raws
//
// Triggers: the Aryeo webhook's APPOINTMENT branch (seconds after booking /
// reschedule / cancel) + the hourly cron sweep as the net. Idempotent at every
// layer: create swallows conflicts, move refuses to clobber an existing
// destination (returns "conflict" and leaves both for a human), archive skips
// anything already under /Canceled/.
//
// ONE FOLDER PER JOB (Sep 8 2026 audit, 1946 Rowan St). The convention name
// has no disambiguator, so a same-street re-shoot for the same client in the
// same month computed the SAME path as the first job, and the engine adopted
// the first job's folder as its own: the Sep 9 re-shoot inherited the Sep 3
// job's 84 raws, flipped to SHOT at import, stamped uploadedAt, rang the
// editor bell and told Harrison "you're good to go" before he had shot.
// Jordan's call (Sep 8): re-shoots get their OWN folder. The rules:
//   • the OLDEST job (createdAt) keeps the plain Zapier-era name the team
//     knows; a later job whose plain name another live job owns gets the
//     shoot date appended — "1946 Rowan St (William Hannum) — Sep 9"
//   • "owns" = a non-cancelled project recorded that path, or (a Zapier-era
//     row with no record) computes it from its own street/client/month
//   • a folder that TWO live jobs record is never moved or archived on the
//     younger job's behalf — the younger one gets a fresh folder of its own
//     and the timeline says so; any files of its own that already landed in
//     the shared folder stay put for a human to move (nothing is deleted)
//   • a path another live job RECORDS is never taken by a job without a
//     record, whatever its age (the older of two jobs that both record the
//     plain name keeps it; the younger yields on its own pass)
//   • a name once given to a job sticks (plain or dated) until the shoot
//     month changes, so the sweep doesn't rename folders back and forth —
//     except that a dated name follows the shoot DAY within the month
// ---------------------------------------------------------------------------

const SUBFOLDERS: (keyof ProjectFolders)[] = ["rawPhotos", "rawVideo", "backupPhotos", "finalPhotos", "finalVideo"];

export type EnsureResult = "created" | "repaired" | "exists" | "moved" | "archived" | "conflict" | "skipped";

type EnsureProject = FolderProject & { id: string; status: string; dropboxFolder: string | null };

type Claimant = {
  id: string;
  createdAt: Date;
  shootDate: Date | null;
  dropboxFolder: string | null;
  /** listing paths this job can lay claim to, lower-cased (Dropbox paths are case-insensitive) */
  recorded: string | null;
  derived: string | null;
};

const lc = (s: string) => s.trim().toLowerCase();

// Every OTHER live project that can lay claim to a listing folder under
// `plain` (this job's convention path): by record (Project.dropboxFolder is
// that path or a dated variant of it) or by derivation (same client + street,
// so its own convention path may be the same one). One query — there is no
// index on the folder/street columns, the table is small — and the exact
// compare happens in memory.
async function otherClaimants(p: EnsureProject, plain: string): Promise<Claimant[]> {
  const street = streetOf(p);
  const rows = await prisma.project.findMany({
    where: {
      id: { not: p.id },
      status: { not: "CANCELLED" },
      OR: [
        { dropboxFolder: { startsWith: plain, mode: "insensitive" } },
        {
          client: { name: p.client.name },
          OR: [
            { addressLine: { equals: street, mode: "insensitive" } },
            { title: { startsWith: street, mode: "insensitive" } },
          ],
        },
      ],
    },
    select: {
      id: true, createdAt: true, shootDate: true, dropboxFolder: true, title: true, addressLine: true,
      client: { select: { name: true } },
    },
  });
  return rows.map((o) => ({
    id: o.id,
    createdAt: o.createdAt,
    shootDate: o.shootDate,
    dropboxFolder: o.dropboxFolder,
    recorded: o.dropboxFolder ? lc(o.dropboxFolder) : null,
    // No record → the Zap (or nobody) put it at the convention path. A recorded
    // row claims ONLY its record: its convention path may have moved on.
    derived: !o.dropboxFolder && o.client ? lc(projectFolderPaths({ ...o, client: o.client }).listing) : null,
  }));
}

const isOlder = (o: { createdAt: Date; id: string }, p: { createdAt: Date; id: string }) =>
  o.createdAt.getTime() < p.createdAt.getTime() || (o.createdAt.getTime() === p.createdAt.getTime() && o.id < p.id);

export type OwnListingPath = {
  /** the listing path this job owns under the CURRENT shoot month */
  target: string;
  /** the job's recorded folder is one another, OLDER live job also records — do not move/archive it, start fresh */
  sharedWith: Claimant | null;
  /** true when `target` carries the shoot-date suffix */
  dated: boolean;
};

// Which listing path THIS job owns under its current shoot month. Reads only;
// exported so a probe can preview the outcome for every same-street group.
export async function resolveOwnListingPath(p: EnsureProject, plain: string = projectFolderPaths(p).listing): Promise<OwnListingPath> {
  const claimants = await otherClaimants(p, plain);
  const mine = p.dropboxFolder?.trim() || null;
  // Strong claim only (a RECORD, by an older job) decides "shared": a derived
  // claim from a Zapier-era row must not pull a job off a folder the engine
  // created for it.
  const sharedWith = mine ? claimants.find((o) => o.recorded === lc(mine) && isOlder(o, p)) ?? null : null;
  const claimedByAny = (path: string) => claimants.some((o) => o.recorded === lc(path) || o.derived === lc(path));
  const claimedByOlder = (path: string) => claimants.some((o) => (o.recorded === lc(path) || o.derived === lc(path)) && isOlder(o, p));
  const recordedByAny = (path: string) => claimants.some((o) => o.recorded === lc(path));
  const firstFreeDated = (): OwnListingPath | null => {
    for (let n = 1; n <= 9; n++) {
      const candidate = disambiguatedListingPath(plain, p, n);
      if (!claimedByAny(candidate)) return { target: candidate, sharedWith, dated: true };
    }
    return null;
  };

  // Sticky: a name already given to this job under this month stands.
  if (mine && !sharedWith && !mine.includes("/Canceled/") && (lc(mine) === lc(plain) || lc(mine).startsWith(lc(`${plain} — `)))) {
    const dated = lc(mine) !== lc(plain);
    // …except that a dated name follows the shoot DATE within the month
    // (review, Sep 8): a "— Sep 9" folder for a shoot moved to Sep 15 lies to
    // the team who navigate by it. Only when the day changed and the new name
    // is free — the reschedule move below renames the folder (files ride
    // along; it refuses to clobber). "(2)" siblings on the same day stay put.
    const today = disambiguatedListingPath(plain, p);
    const sameDay = lc(mine) === lc(today) || lc(mine).startsWith(lc(`${today} (`));
    if (dated && !sameDay) {
      const renamed = firstFreeDated();
      if (renamed) return { ...renamed, sharedWith: null };
    }
    return { target: mine, sharedWith: null, dated };
  }
  // The plain name is this job's unless an OLDER live job has it (a younger
  // one that grabbed it yields on its own pass — the sticky rule above keeps
  // the older one on it), or ANY live job RECORDS it: a path another job's
  // record names is never taken by a job without a record, whatever its age
  // (review, Sep 8 — an order that was dateless at import and got scheduled
  // into a month where a younger same-street order had already created the
  // plain folder would otherwise adopt that folder and push the younger job,
  // raws and all, onto a dated name).
  if (!claimedByOlder(plain) && !recordedByAny(plain)) return { target: plain, sharedWith, dated: false };
  const dated = firstFreeDated();
  if (dated) return dated;
  // Ten same-day re-shoots of one street: not a real case — fall back to the
  // id so the engine still never adopts someone else's folder.
  return { target: `${plain} — ${p.id.slice(-6)}`, sharedWith, dated: true };
}

// Is `path` a listing folder some OTHER live job records or derives? Used by
// the archive step and the legacy sweep so neither acts on a shared folder.
async function claimedByAnotherLiveJob(p: EnsureProject, path: string): Promise<boolean> {
  const claimants = await otherClaimants(p, path);
  return claimants.some((o) => o.recorded === lc(path) || o.derived === lc(path));
}

async function listingSubfolders(path: string): Promise<Set<string> | null> {
  try {
    return new Set((await dropboxListFolder(path)).filter((e) => e.tag === "folder").map((e) => e.name));
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return null;
    throw e; // auth/rate-limit — the caller must not mistake this for "absent"
  }
}

async function rememberPath(projectId: string, path: string, note?: string): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { dropboxFolder: path } });
  if (note) {
    await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: note } }).catch(() => {});
  }
}

// Make sure ONE project's Dropbox presence matches reality. The Zap's output
// is 01/02/04/05; the hub adds 03-Backup-Photos on create AND on the repair
// pass, so existing upcoming shoots pick it up on the next hourly sweep.
export async function ensureProjectFolders(p: EnsureProject): Promise<EnsureResult> {
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) return "skipped";

  // CANCELLED → archive the folder if we know where it is (or can compute it).
  if (p.status === "CANCELLED") {
    const from = p.dropboxFolder ?? (p.shootDate ? projectFolderPaths(p).listing : null);
    if (!from || from.includes("/Canceled/")) return "skipped"; // nothing to do / already archived
    // Never archive a folder another LIVE job owns: a cancelled re-shoot order
    // with no record of its own computes the FIRST job's path (Sep 8 2026).
    if (await claimedByAnotherLiveJob(p, from)) return "skipped";
    if ((await listingSubfolders(from)) === null) return "skipped"; // no folder exists — nothing to archive
    const year = from.match(/^\/AutoHDR\/(\d{4})\//)?.[1] ?? "0000";
    const to = `/AutoHDR/Canceled/${year}/${from.split("/").pop()}`;
    const ok = await dropboxMoveFolder(from, to);
    await rememberPath(p.id, ok ? to : from, ok ? `Dropbox folder archived (job cancelled): ${to}` : undefined);
    return ok ? "archived" : "conflict";
  }

  // No shoot date yet → the path (year/quarter/month) isn't knowable. The
  // webhook/sweep runs again once the appointment lands.
  if (!p.shootDate) return "skipped";

  // The job's OWN listing path — the convention path unless an older live job
  // already owns it (same street, same client, same month: a re-shoot), in
  // which case the shoot date is appended. See the one-folder-per-job rules.
  const own = await resolveOwnListingPath(p);
  const f = foldersUnder(own.target);
  const splitNote = own.sharedWith
    ? `Dropbox folder split from the ${etShortDate(own.sharedWith.shootDate ?? own.sharedWith.createdAt)} job — re-shoots get their own folder: ${own.target}`
    : null;

  // RESCHEDULE — we know where the folder was, and it isn't where the current
  // shoot date says it should be. Move it (files ride along), then fall
  // through to verify the subfolders at the new location. Never when the
  // recorded folder is another live job's too — that would carry THEIR files
  // off under this job's name; the younger job starts fresh below instead.
  if (p.dropboxFolder && p.dropboxFolder !== own.target && !p.dropboxFolder.includes("/Canceled/") && !own.sharedWith) {
    const oldExists = (await listingSubfolders(p.dropboxFolder)) !== null;
    if (oldExists) {
      const ok = await dropboxMoveFolder(p.dropboxFolder, own.target);
      if (!ok) return "conflict"; // both old and new exist — a human must merge; do NOT clobber
      await rememberPath(p.id, own.target, `Dropbox folder moved (reschedule): ${p.dropboxFolder} → ${own.target}`);
      return "moved";
    }
    // Old location is gone (someone moved it by hand) — treat as fresh below.
  }

  // A folder already at the job's OWN path is adopted. resolveOwnListingPath
  // never hands out a path another live job records or (for a Zapier-era row
  // with no record) derives, so what sits here is this job's own folder, a
  // Zapier-era folder nobody else can claim, or a hand-made one.
  const existing = await listingSubfolders(own.target);
  if (existing) {
    const missing = SUBFOLDERS.filter((k) => !existing.has(f[k].split("/").pop()!));
    for (const k of missing) await dropboxCreateFolder(f[k]);
    if (p.dropboxFolder !== own.target) await rememberPath(p.id, own.target, splitNote ?? undefined);
    return missing.length ? "repaired" : "exists";
  }

  await dropboxCreateFolder(own.target);
  for (const k of SUBFOLDERS) await dropboxCreateFolder(f[k]);
  await rememberPath(
    p.id,
    own.target,
    splitNote ?? `Dropbox folders created: ${own.target}${own.dated ? " (same street as an earlier job this month — re-shoots get their own folder)" : ""}`,
  );
  return "created";
}

const ENSURE_SELECT = {
  id: true, title: true, addressLine: true, shootDate: true, createdAt: true,
  status: true, dropboxFolder: true, client: { select: { name: true } },
} as const;

// The hourly net: upcoming shoots get created/moved, freshly-cancelled jobs
// with a known folder get archived. One list call per project; sequential so
// a burst of bookings can't trip Dropbox rate limits.
export async function ensureFoldersForUpcomingShoots(): Promise<{
  checked: number; created: number; moved: number; archived: number; repaired: number; conflicts: string[]; failed: string[];
  /** CP-09 — null when the topic_folders switch is off (nothing was looked at) */
  topicFolders: { checked: number; created: number; adopted: number; failed: string[] } | null;
}> {
  const out = {
    checked: 0, created: 0, moved: 0, archived: 0, repaired: 0, conflicts: [] as string[], failed: [] as string[],
    topicFolders: null as { checked: number; created: number; adopted: number; failed: string[] } | null,
  };
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) return out;
  const windowStart = new Date(Date.now() - 86_400_000);
  const [upcoming, cancelled] = await Promise.all([
    prisma.project.findMany({
      where: { shootDate: { gte: windowStart, lte: new Date(Date.now() + 60 * 86_400_000) }, status: { notIn: ["CANCELLED"] } },
      orderBy: { shootDate: "asc" }, take: 80, select: ENSURE_SELECT,
    }),
    // Cancelled jobs whose folder we created/tracked and haven't archived yet.
    prisma.project.findMany({
      where: { status: "CANCELLED", dropboxFolder: { not: null, notIn: [] } },
      take: 20, select: ENSURE_SELECT,
    }).then((rows) => rows.filter((r) => r.dropboxFolder && !r.dropboxFolder.includes("/Canceled/"))),
  ]);
  for (const p of [...upcoming, ...cancelled]) {
    out.checked++;
    try {
      const r = await ensureProjectFolders(p);
      if (r === "created") out.created++;
      if (r === "moved") out.moved++;
      if (r === "archived") out.archived++;
      if (r === "repaired") out.repaired++;
      if (r === "conflict") out.conflicts.push(p.title.split(",")[0]);
    } catch {
      out.failed.push(p.title.split(",")[0]);
    }
  }

  // CP-09: the topic folders of every content session in the same window —
  // AFTER the loop above, so a listing folder made this pass is on record.
  // Keyed on the session's appointments as well as shootDate: a Pro month on
  // one project carries the FIRST session's date, and its second session a
  // week later still needs folders for what is left. And on a recent submit:
  // an extra filmed on site whose folder the submit could not make (a Dropbox
  // blip) is made here, however long ago the session was. Behind
  // topic_folders; a missing row is off, and then not one Dropbox call is made
  // for it.
  if (await isAutomationEnabled("topic_folders")) {
    const until = new Date(Date.now() + 60 * 86_400_000);
    const content = await prisma.project.findMany({
      where: {
        contentMonthId: { not: null },
        status: { not: "CANCELLED" },
        dropboxFolder: { not: null },
        OR: [
          { shootDate: { gte: windowStart, lte: until } },
          { appointments: { some: { startAt: { gte: windowStart, lte: until } } } },
          { debriefSubmittedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
        ],
      },
      orderBy: { shootDate: "asc" },
      take: 40,
      select: { id: true, title: true },
    });
    const tf = { checked: 0, created: 0, adopted: 0, failed: [] as string[] };
    for (const p of content) {
      tf.checked++;
      try {
        const r = await ensureTopicFolders(p.id);
        tf.created += r.created;
        tf.adopted += r.adopted;
        if (r.failed.length) tf.failed.push(p.title.split(",")[0]);
      } catch {
        tf.failed.push(p.title.split(",")[0]);
      }
    }
    out.topicFolders = tf;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CP-09 — ONE RAW FOLDER PER TOPIC (Sep 24 2026, batch C).
//
// A content session films four or eight different videos into ONE
// 02-RAW-Video folder, and the editor had to work out from the clips which
// were which. Now each of the session's topics gets its own folder:
//
//     02-RAW-Video/01 Pricing in week one [a1b2c3d4]
//
// The number is the topic's place on the month's list when the folder was
// made; the bracket is the last eight characters of the topic's PERMANENT id.
// The bracket is what identifies it, never the words — so:
//   · a topic RENAMED in the hub keeps its folder. The hub does not rename it
//     to match (a rename would move the clips under the photographer's feet
//     mid-upload); the brief shows the new title beside the old folder name.
//   · a folder RENAMED BY HAND is found again by its bracket, or failing that
//     by its Dropbox id (recorded at creation, and it survives any rename), and
//     adopted under its new name.
//   · nothing here renames, moves or deletes. The only Dropbox calls are one
//     listing of 02-RAW-Video and a create for a topic with no folder, and a
//     create that finds something already there adopts it.
//
// The hub makes a topic's folder in the job's CURRENT listing folder, which the
// folder engine above owns — no listing folder on record, nothing is made here
// (making 02-RAW-Video would create the listing outside the engine's
// one-folder-per-job rules). A topic confirmed at another session of the month
// is that session's, and gets no folder here.
//
// Behind the topic_folders switch (a missing row is off): it is the first
// automated write inside a job folder beyond the five numbered subfolders.
// Raws-in detection is unaffected — folderFileCount and videoFilesUnder are
// recursive, so a clip in a topic folder is still footage in 02-RAW-Video.
// ---------------------------------------------------------------------------

/** The part of a topic folder's name that never changes: the id's last eight. */
export function topicFolderTag(topicId: string): string {
  return `[${topicId.slice(-8)}]`;
}

/**
 * "01 Pricing in week one [a1b2c3d4]". Dropbox refuses / \ : ? * < > " | and a
 * trailing dot or space, so those go; a long title is cut at a word near 60
 * characters so the bracket is always on the end.
 */
export function topicFolderName(rank: number, title: string, topicId: string): string {
  const clean = title
    .replace(/[/\\:?*<>"|]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const short = clean.length <= 60 ? clean : clean.slice(0, 60).replace(/\s+\S*$/, "").trim() || clean.slice(0, 60).trim();
  const words = short.replace(/[. ]+$/, "") || "Topic";
  return `${String(Math.max(1, Math.min(99, Math.round(rank)))).padStart(2, "0")} ${words} ${topicFolderTag(topicId)}`;
}

export type TopicFolderResult = {
  /** off = the switch; skipped = nothing to do here (reason says why); done = it looked */
  state: "off" | "skipped" | "done";
  reason: string | null;
  created: number;
  /** found under a name the hub did not give it (renamed by hand, or made by a person) */
  adopted: number;
  /** already on record and still where the record says */
  kept: number;
  /** topic titles whose folder could not be made this run */
  failed: string[];
};

/**
 * Make sure every topic of this session has its raw folder, adopting any that
 * already exist. Idempotent and safe to run from anywhere at once: a create
 * that loses a race finds the folder and adopts it, and the record is
 * createMany + skipDuplicates on (projectId, topicId).
 */
export async function ensureTopicFolders(projectId: string): Promise<TopicFolderResult> {
  const out: TopicFolderResult = { state: "skipped", reason: null, created: 0, adopted: 0, kept: 0, failed: [] };
  // The switch FIRST — before the project is read, and long before Dropbox.
  if (!(await isAutomationEnabled("topic_folders"))) return { ...out, state: "off", reason: "topic_folders is off" };
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) return { ...out, reason: "Dropbox is not connected" };
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { ...ENSURE_SELECT, contentMonthId: true } });
  if (!p?.contentMonthId) return { ...out, reason: "not a content session" };
  if (p.status === "CANCELLED") return { ...out, reason: "the job is cancelled" };
  if (!p.dropboxFolder?.trim() || p.dropboxFolder.includes("/Canceled/")) return { ...out, reason: "the job's own folder is not on record yet" };

  const { topicsForSession } = await import("@/lib/filmedTopics");
  const session = await topicsForSession(projectId);
  // The rank is the topic's place on the month's WHOLE list, so the numbers on
  // two sessions' folders agree with each other and with the portal.
  const wanted = (session?.topics ?? [])
    .map((t, i) => ({ topicId: t.topicId, title: t.title, rank: i + 1, elsewhere: !!t.confirmedOnProjectId && t.confirmedOnProjectId !== projectId }))
    .filter((t) => !t.elsewhere);
  if (!wanted.length) return { ...out, reason: "no topics on this session" };

  const rawVideo = actualFolderPaths(p).rawVideo;
  let children: { name: string; path: string; id: string | null }[];
  try {
    children = (await dropboxListFolder(rawVideo)).filter((e) => e.tag === "folder");
  } catch (e) {
    // The engine repairs a missing 02-RAW-Video on its next pass; making it
    // here would make the listing folder behind the engine's back.
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return { ...out, reason: "02-RAW-Video is not there yet" };
    throw e; // auth / rate limit — the caller must not read this as "nothing to do"
  }
  const rows = await prisma.contentTopicFolder.findMany({
    where: { projectId },
    select: { id: true, topicId: true, dropboxPath: true, dropboxId: true, label: true, state: true },
  });
  const rowOf = new Map(rows.map((r) => [r.topicId, r]));
  const claimed = new Set<string>();

  const record = async (topicId: string, data: { dropboxPath: string; dropboxId: string | null; label: string; state: string; lastError: string | null }) => {
    const made = await prisma.contentTopicFolder.createMany({ data: [{ projectId, topicId, ...data }], skipDuplicates: true });
    if (!made.count) {
      // A FAILED row learns where the folder is; a good row keeps the id it
      // already has when this read did not bring one.
      await prisma.contentTopicFolder.updateMany({
        where: { projectId, topicId },
        data: { dropboxPath: data.dropboxPath, label: data.label, state: data.state, lastError: data.lastError, ...(data.dropboxId ? { dropboxId: data.dropboxId } : {}) },
      });
    }
  };

  out.state = "done";
  for (const t of wanted) {
    const row = rowOf.get(t.topicId) ?? null;
    const tag = topicFolderTag(t.topicId).toLowerCase();
    // Its Dropbox id first (survives any rename), then its bracket.
    const byId = row?.dropboxId ? children.find((c) => c.id === row.dropboxId && !claimed.has(c.path.toLowerCase())) : undefined;
    const byTag = children
      .filter((c) => c.name.toLowerCase().endsWith(tag) && !claimed.has(c.path.toLowerCase()))
      .sort((a, b) => (a.name === row?.label ? -1 : b.name === row?.label ? 1 : a.name.localeCompare(b.name)));
    const found = byId ?? byTag[0];
    try {
      if (found) {
        const path = found.path || `${rawVideo}/${found.name}`;
        claimed.add(path.toLowerCase());
        const known = !!row && row.state !== "FAILED" && row.label === found.name;
        // Same name: kept. Only the path moved (the engine moved the listing
        // on a reschedule, and the folder rode along) — the record follows.
        if (known && row!.dropboxPath.toLowerCase() === path.toLowerCase() && (!found.id || row!.dropboxId === found.id)) {
          out.kept++;
          continue;
        }
        await record(t.topicId, {
          dropboxPath: path,
          dropboxId: found.id,
          label: found.name,
          // Who made it stays true: the hub's own folder renamed by hand is
          // still CREATED; one the hub never made (or lost track of) is ADOPTED.
          state: row && row.state !== "FAILED" ? row.state : "ADOPTED",
          lastError: null,
        });
        if (known) out.kept++;
        else out.adopted++;
        continue;
      }
      const name = topicFolderName(t.rank, t.title, t.topicId);
      const path = `${rawVideo}/${name}`;
      const meta = await dropboxCreateFolderMeta(path);
      claimed.add(path.toLowerCase());
      // null = something already sits at exactly that path (a run racing this
      // one): it carries this topic's bracket, so it is this topic's folder.
      await record(t.topicId, { dropboxPath: meta?.path ?? path, dropboxId: meta?.id ?? null, label: name, state: meta ? "CREATED" : "ADOPTED", lastError: null });
      if (meta) out.created++;
      else out.adopted++;
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 500);
      out.failed.push(t.title);
      await record(t.topicId, {
        dropboxPath: row?.dropboxPath ?? `${rawVideo}/${topicFolderName(t.rank, t.title, t.topicId)}`,
        dropboxId: row?.dropboxId ?? null,
        label: row?.label ?? topicFolderName(t.rank, t.title, t.topicId),
        state: "FAILED",
        lastError: error,
      }).catch(() => {});
    }
  }
  return out;
}

/**
 * Where each topic's folder IS, for the upload page and the editor's brief:
 * the recorded folder NAME under the job's CURRENT 02-RAW-Video. The stored
 * path is not trusted on its own — the folder engine moves the whole listing
 * on a reschedule (files and topic folders ride along), and the name is what
 * travels. A FAILED row has no folder behind it, so it has no link.
 */
export async function topicFolderLinksFor(projectId: string): Promise<Map<string, { label: string; path: string; url: string }>> {
  const out = new Map<string, { label: string; path: string; url: string }>();
  const rows = await prisma.contentTopicFolder.findMany({
    where: { projectId, state: { not: "FAILED" } },
    select: { topicId: true, label: true, dropboxPath: true },
  });
  if (!rows.length) return out;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } } });
  const rawVideo = p ? actualFolderPaths(p).rawVideo : null;
  for (const r of rows) {
    const path = rawVideo ? `${rawVideo}/${r.label}` : r.dropboxPath;
    out.set(r.topicId, { label: r.label, path, url: dropboxWebUrl(path) });
  }
  return out;
}

// A missing folder is a trustworthy ZERO (nothing was uploaded there). Any
// OTHER failure — auth, rate limit, network — is UNKNOWN, not zero: an expired
// token used to render every folder "empty" to a photographer double-checking
// their 300-raw drop (July 2026 audit). Same null semantics as the status
// sweep's folderCount.
export async function folderFileCount(path: string, onError?: (e: unknown) => void): Promise<number | null> {
  try {
    // Recursive: a card dump inside a subfolder is still footage that's IN.
    const entries = await dropboxListFolder(path, { recursive: true });
    return entries.filter((e) => e.tag === "file").length;
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return 0;
    onError?.(e); // WHY it failed (429 vs 401) — the contract stays number|null
    return null; // couldn't look — the caller must not treat this as "empty"
  }
}

// Video files anywhere under the job's listing folder — not just 02-RAW-Video.
// A photographer who drops clips into 01-RAW-Photos, or straight into the
// listing folder, HAS delivered the footage; warning them that "the RAW-Video
// folder is empty (a video is ordered!)" every time they submit is the hub
// being pedantic about a folder name rather than looking for the files.
// Returns null when the read failed — unknown is never "empty".
const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|mts|m2ts|mxf|braw|r3d|insv|lrv|wmv|webm|avchd|3gp)$/i;

export async function videoFilesUnder(
  listingPath: string,
  onError?: (e: unknown) => void,
): Promise<{ count: number; sample: string[]; where: string[] } | null> {
  try {
    const entries = await dropboxListFolder(listingPath, { recursive: true });
    const vids = entries.filter((e) => e.tag === "file" && VIDEO_EXT.test(e.name));
    // Which sub-folder each one is in, relative to the listing folder — so the
    // page can say "12 clips are in 01-RAW-Photos" instead of "empty".
    const where = [...new Set(vids.map((v) => {
      const rel = (v.path ?? "").toLowerCase().slice(listingPath.toLowerCase().length + 1);
      const seg = rel.split("/")[0];
      return rel.includes("/") ? seg : "the listing folder";
    }))].filter(Boolean);
    return { count: vids.length, sample: vids.slice(0, 3).map((v) => v.name), where };
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return { count: 0, sample: [], where: [] };
    onError?.(e);
    return null;
  }
}

// Web deep-link that opens a folder in the Dropbox web app (team members land
// in the team space they have access to).
export function dropboxWebUrl(path: string): string {
  return `https://www.dropbox.com/home${path.split("/").map(encodeURIComponent).join("/")}`;
}

// Live folder state for the upload portal: per-folder file counts + open links.
// Returns null when Dropbox isn't connected so the UI can degrade gracefully.
export async function getProjectFolderState(p: FolderProject): Promise<{
  connected: boolean;
  // count null = the read FAILED (auth/rate-limit/network) — render "?", never
  // "empty". A photographer double-checking a 300-raw drop must not see 0.
  folders: { key: keyof ProjectFolders; label: string; path: string; url: string; count: number | null; raw: boolean }[];
  hasRaw: boolean;
  hasFinal: boolean;
  readFailed: boolean;
} | null> {
  const f = actualFolderPaths(p);
  const defs: { key: keyof ProjectFolders; label: string; raw: boolean }[] = [
    { key: "rawPhotos", label: "Raw Photos", raw: true },
    { key: "rawVideo", label: "Raw Video", raw: true },
    { key: "backupPhotos", label: "Backup Photos", raw: true },
    { key: "finalPhotos", label: "Final Photos", raw: false },
    { key: "finalVideo", label: "Final Video", raw: false },
  ];

  const connected = dropboxConfigured() && !!(await getSecret("dropbox"));
  const counts = connected
    ? await Promise.all(defs.map((d) => folderFileCount(f[d.key])))
    : defs.map(() => 0);

  const folders = defs.map((d, i) => ({
    key: d.key,
    label: d.label,
    path: f[d.key],
    url: dropboxWebUrl(f[d.key]),
    count: counts[i],
    raw: d.raw,
  }));
  const hasRaw = folders.filter((x) => x.raw).some((x) => (x.count ?? 0) > 0);
  const hasFinal = folders.filter((x) => !x.raw).some((x) => (x.count ?? 0) > 0);
  const readFailed = connected && counts.some((c) => c === null);
  return { connected, folders, hasRaw, hasFinal, readFailed };
}

// Raw-photo folder count for ONE project (a single Dropbox call), for the upload
// list's "over budget" chip. Returns null when Dropbox isn't connected so the
// caller can skip the whole batch. Kept lean (raw photos only) so a list of
// shoots doesn't fan out four calls per row like getProjectFolderState.
export async function rawPhotoCounts(
  projects: FolderProject[],
): Promise<Map<FolderProject, number> | null> {
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) return null;
  const out = new Map<FolderProject, number>();
  await Promise.all(
    projects.map(async (p) => {
      // The job's OWN folder (a re-shoot's dated name, a rescheduled shoot's
      // real month) — the convention path counted another job's raws (Sep 8 2026).
      const n = await folderFileCount(actualFolderPaths(p).rawPhotos);
      // A failed read is unknown, not zero — omit the row so the over-budget
      // chip simply doesn't render rather than silently vanishing as "0 raws".
      if (n !== null) out.set(p, n);
    }),
  );
  return out;
}

// Poll each active project's RAW + FINAL folders and advance status accordingly:
//   RAW files present  → SHOT  (photographer uploaded → ready for editing/QA)
//   FINAL files present → REVIEW (editor done → QC then deliver)
export async function syncDropboxFolderStatus(): Promise<{
  checked: number;
  movedToShot: number;
  movedToReview: number;
}> {
  if (!dropboxConfigured() || !(await getSecret("dropbox"))) {
    throw new Error("Dropbox is not connected.");
  }

  const projects = await prisma.project.findMany({
    where: { source: "ARYEO", status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW"] } },
    include: { client: { select: { name: true } }, appointments: { select: { status: true, startAt: true } } },
  });
  // The status sweep's own "the shoot happened" test (a past leg counts, a
  // bare future shootDate does not) — dynamic import, the two modules cite
  // each other.
  const { shootHappenedFor } = await import("@/lib/projectStatus");
  // The office's Waiting hold (Sep 11, queueWaiting.ts): a job the office put
  // back to Waiting must not be flipped to SHOT by this sweep either — the
  // raws it sees are the very files the office said are not this job's.
  // Loaded once; the same submit-after-hold test the status sweep uses.
  const { loadWaitingHolds, holdStands } = await import("@/lib/queueWaiting");
  const holds = await loadWaitingHolds(projects.map((p) => p.id));

  let movedToShot = 0;
  let movedToReview = 0;

  for (const p of projects) {
    // The job's OWN folder, not the convention path (Sep 8 2026 audit: this
    // legacy sweep was the third writer that could flip a re-shoot to SHOT on
    // the first job's raws).
    const f = actualFolderPaths(p);
    const [rawP, rawV, finP, finV] = (
      await Promise.all([
        folderFileCount(f.rawPhotos),
        folderFileCount(f.rawVideo),
        folderFileCount(f.finalPhotos),
        folderFileCount(f.finalVideo),
      ])
    ).map((n) => n ?? 0); // legacy manual sweep: unknown reads as 0 (advance-only logic)
    const hasRaw = rawP + rawV > 0;
    const hasFinal = finP + finV > 0;

    // The office's status pin (Sep 13, editOverrides.ts): a pinned status is
    // no engine's to move, this legacy sweep included — the same rule the
    // hourly status sweep runs. `include` above already carries the column.
    if (p.statusPinnedAt) continue;

    if (hasFinal && (p.status === "SHOT" || p.status === "EDITING")) {
      await prisma.project.update({ where: { id: p.id }, data: { status: "REVIEW" } });
      await prisma.activity.create({
        data: { projectId: p.id, type: "SYSTEM", body: `Final media detected in Dropbox (${finP + finV} files) → moved to Review.` },
      });
      movedToReview++;
    } else if (hasRaw && (p.status === "BOOKED" || p.status === "SCHEDULED")) {
      // A shoot that hasn't happened has no raws of its own, and a folder
      // another live job also claims is not evidence about this one.
      if (!shootHappenedFor(p)) continue;
      if (holdStands(holds.get(p.id), p.debriefSubmittedAt)) continue;
      if (await claimedByAnotherLiveJob(p, f.listing)) continue;
      await prisma.project.update({ where: { id: p.id }, data: { status: "SHOT", uploadedAt: new Date() } });
      await prisma.activity.create({
        data: { projectId: p.id, type: "SYSTEM", body: `Raw media detected in Dropbox (${rawP + rawV} files) → moved to Shot/Uploaded.` },
      });
      // Complete any open confirmation task for this project (the shoot happened).
      await prisma.smartTask.updateMany({
        where: { projectId: p.id, taskType: { in: ["confirmation_text", "appointment_prep"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      // Raws landed → ping the editors + mint the premium-reel Luma dispatch
      // task (audit crack #19). Idempotent; best-effort so it never breaks the sweep.
      try {
        const { notifyRawsLanded } = await import("@/lib/tasks");
        await notifyRawsLanded(p.id);
      } catch { /* non-fatal */ }
      movedToShot++;
    }
  }

  // Regenerate package tasks so the newly-SHOT projects get QA/delivery tasks.
  if (movedToShot > 0 || movedToReview > 0) await generateTasksForActiveProjects();

  return { checked: projects.length, movedToShot, movedToReview };
}
