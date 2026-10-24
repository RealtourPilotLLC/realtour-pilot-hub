// ---------------------------------------------------------------------------
// THE WRONG-FILE CHECK, READ FROM THE DATABASE (Oct 23 2026). The rule and its
// words are lib/wrongCutFileCore (pure); this file only gathers what it needs:
// the job, the other jobs whose street the file's name might be naming (the
// same client's, then any job booked or shot in the last 120 days), and the
// cuts that share the file's name and size.
//
// Read-only, and it never stands in anybody's way: every caller treats a
// failure or a slow answer as "nothing to say" (withinMs) and the upload goes
// ahead as it always did.
//
// Callers: the upload panel's check before the bytes (review/actions
// checkCutUploadFile), the reservation that registers the cut (startCutUpload,
// which refuses without an override), the Review Room's cut panel and the
// Ready to send card (both for the version on screen, at view time).
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";
import { checkCutFile, type WrongFileCandidate, type WrongFileJob, type WrongFileTwin, type WrongFileVerdict } from "@/lib/wrongCutFileCore";

const RECENT_DAYS = 120;
/** Versions that are not evidence: an upload still going, one that failed, and
 *  a version taken back (the legacy WITHDRAWN rows; a removal deletes the row
 *  today), which was somebody saying "wrong file" already. */
const NOT_A_CUT = ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"];

/** The legacy `ident:` pins are a URL's identity, not the bytes': only a real hash compares. */
const realHash = (h: string | null | undefined): string | null => (h && !/^ident/i.test(h) ? h : null);

/** null when the promise takes longer than `ms` or fails: the check never holds an upload up. */
export async function withinMs<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); })]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const JOB_SELECT = { id: true, title: true, addressLine: true, city: true, state: true, zip: true, clientId: true, createdAt: true, shootDate: true, client: { select: { name: true } } } as const;
type JobRow = { id: string; title: string; addressLine: string | null; city: string | null; state: string | null; zip: string | null; clientId: string; createdAt: Date; shootDate: Date | null; client: { name: string } | null };
const toJob = (p: JobRow): WrongFileJob => ({ projectId: p.id, title: p.title, addressLine: p.addressLine, city: p.city, state: p.state, zip: p.zip, clientId: p.clientId, clientName: p.client?.name ?? null });

/** The same clients' jobs, then every job booked or shot recently. One read. */
async function candidatesFor(clientIds: string[], now: Date): Promise<WrongFileCandidate[]> {
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
  const rows = (await prisma.project.findMany({
    where: { OR: [...(clientIds.length ? [{ clientId: { in: clientIds } }] : []), { createdAt: { gte: since } }, { shootDate: { gte: since } }] },
    select: JOB_SELECT,
    orderBy: { createdAt: "desc" },
    take: 3000,
  })) as JobRow[];
  return rows.map((p) => ({ ...toJob(p), at: p.shootDate ?? p.createdAt }));
}

const TWIN_SELECT = {
  id: true, projectId: true, fileName: true, sizeBytes: true, contentHash: true, deliverableId: true, slot: true, round: true, createdAt: true,
  submittedByKey: true, submittedByName: true, project: { select: { title: true, addressLine: true } },
} as const;
type TwinRow = {
  id: string; projectId: string; fileName: string | null; sizeBytes: number | null; contentHash: string | null; deliverableId: string | null; slot: number; round: number; createdAt: Date;
  submittedByKey: string | null; submittedByName: string | null; project: { title: string; addressLine: string | null };
};

function twinOf(r: TwinRow, file: { name: string; size: number | null; hash: string | null }): WrongFileTwin | null {
  const sameNameSize = !!file.size && r.sizeBytes === file.size && (r.fileName ?? "") === file.name;
  const sameHash = !!file.hash && realHash(r.contentHash) === file.hash;
  if (!sameNameSize && !sameHash) return null;
  return {
    submissionId: r.id, projectId: r.projectId, job: r.project, deliverableId: r.deliverableId, slot: r.slot, round: r.round, createdAt: r.createdAt,
    byKey: r.submittedByKey, byName: r.submittedByName, how: sameHash ? "hash" : "name-size",
  };
}

/** Would this file look wrong for this job? Asked BEFORE any bytes go up, and
 *  again when the cut is registered. */
export async function wrongFileForUpload(input: {
  projectId: string;
  deliverableId: string | null;
  slot: number | null;
  fileName: string;
  sizeBytes: number | null;
  uploader: { key: string | null; name: string | null } | null;
  now?: Date;
}): Promise<WrongFileVerdict | null> {
  // Compared exactly as the reservation stores it (startCutUpload keeps the
  // first 200 characters, untrimmed).
  const name = (input.fileName ?? "").slice(0, 200);
  if (!name.trim()) return null;
  const size = Number.isFinite(input.sizeBytes) && Number(input.sizeBytes) > 0 ? Math.floor(Number(input.sizeBytes)) : null;
  const now = input.now ?? new Date();
  const job = (await prisma.project.findUnique({ where: { id: input.projectId }, select: JOB_SELECT })) as JobRow | null;
  if (!job) return null;
  const [candidates, twinRows] = await Promise.all([
    candidatesFor([job.clientId], now),
    size
      ? prisma.reviewSubmission.findMany({
          where: { kind: "video", fileName: name, sizeBytes: size, status: { notIn: NOT_A_CUT } },
          select: TWIN_SELECT,
          orderBy: { createdAt: "desc" },
          take: 20,
        }) as Promise<TwinRow[]>
      : Promise.resolve([] as TwinRow[]),
  ]);
  const twins = twinRows.map((r) => twinOf(r, { name, size, hash: null })).filter((t): t is WrongFileTwin => !!t);
  return checkCutFile({
    job: toJob(job),
    file: { name, size },
    slot: { deliverableId: input.deliverableId, slot: input.slot },
    candidates,
    twins,
    uploader: input.uploader,
  });
}

/** The same check for versions already in, as of when each one came in: a
 *  twin uploaded AFTER a version is not held against it (the first job to have
 *  a file is not the one that got it by mistake). Keyed by submission id; a
 *  version with nothing to say is absent. */
export async function wrongFileForSubmissions(ids: string[]): Promise<Map<string, WrongFileVerdict>> {
  const out = new Map<string, WrongFileVerdict>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return out;
  const subs = await prisma.reviewSubmission.findMany({
    where: { id: { in: wanted } },
    select: { id: true, projectId: true, fileName: true, sizeBytes: true, contentHash: true, deliverableId: true, slot: true, createdAt: true, submittedByKey: true, submittedByName: true },
  });
  const files = subs
    .map((s) => ({ s, name: s.fileName ?? "", size: s.sizeBytes && s.sizeBytes > 0 ? s.sizeBytes : null, hash: realHash(s.contentHash) }))
    .filter((f) => !!f.name.trim());
  if (!files.length) return out;
  const projectIds = [...new Set(files.map((f) => f.s.projectId))];
  const jobs = (await prisma.project.findMany({ where: { id: { in: projectIds } }, select: JOB_SELECT })) as JobRow[];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const pairs = files.filter((f) => f.size).map((f) => ({ fileName: f.name, sizeBytes: f.size! }));
  const hashes = [...new Set(files.map((f) => f.hash).filter((h): h is string => !!h))];
  const [candidates, twinRows] = await Promise.all([
    candidatesFor([...new Set(jobs.map((j) => j.clientId))], new Date()),
    pairs.length || hashes.length
      ? (prisma.reviewSubmission.findMany({
          where: {
            kind: "video",
            status: { notIn: NOT_A_CUT },
            OR: [...pairs, ...(hashes.length ? [{ contentHash: { in: hashes } }] : [])],
          },
          select: TWIN_SELECT,
          orderBy: { createdAt: "desc" },
          take: 500,
        }) as Promise<TwinRow[]>)
      : Promise.resolve([] as TwinRow[]),
  ]);
  for (const f of files) {
    const job = jobById.get(f.s.projectId);
    if (!job) continue;
    const twins = twinRows
      .filter((r) => r.id !== f.s.id && r.createdAt < f.s.createdAt)
      .map((r) => twinOf(r, f))
      .filter((t): t is WrongFileTwin => !!t);
    const v = checkCutFile({
      job: toJob(job),
      file: { name: f.name, size: f.size },
      slot: { deliverableId: f.s.deliverableId, slot: f.s.slot },
      candidates,
      twins,
      uploader: { key: f.s.submittedByKey, name: f.s.submittedByName },
    });
    if (v) out.set(f.s.id, v);
  }
  return out;
}
