import "server-only";
import { prisma } from "@/lib/prisma";
import { phoneKey } from "@/lib/integrations/openphone";

// ---------------------------------------------------------------------------
// Duplicate-client REVIEW — report only. Nothing in this file merges or deletes
// a client on a schedule any more.
//
// What it used to do: the nightly step clustered clients and HARD-DELETED the
// losers. It ran for the first time on 2 Sep 2026 and deleted 12 client rows —
// no audit record, no undo. The rule that chose them ("the last 10 digits of
// the phone match") is not identity: a household line, a team line or an office
// line puts two DIFFERENT people in one cluster. That same night's candidate
// list wanted to fold Melissa Fanelli — her own company, her own Aryeo customer
// record, two orders of her own — into Bill Fanelli.
//
// What it does now: it finds the same candidates, records the evidence FOR and
// AGAINST each one, and hands the decision to a human — one decision task per
// candidate on the board, plus the machine-readable list in AppSetting for a
// future approve-in-app flow to read. mergeClientsById() below still merges,
// but only for ids a human picked; nothing automated may call it.
//
// WHAT A SAFE MATCH NEEDS, over and above a matching phone (the rule that
// approve-in-app flow should enforce before it offers a one-click merge):
//   • at most ONE side carries an aryeoCustomerId. Two distinct Aryeo customer
//     ids mean Aryeo itself holds them as two customers, each with its own
//     orders, invoices and delivery emails.
//   • the companies agree, or one side is blank. Two different brokerages/LLCs
//     on one number is the household/office case — i.e. two people.
//   • at most ONE side has orders. Two clients who have each BOUGHT work are
//     never auto-mergeable: merging rewrites whose revenue and whose delivery
//     history it was.
// Failing any of those doesn't hide the pair — it only means a human presses
// merge, never a cron.
// ---------------------------------------------------------------------------

type DedupeClient = {
  id: string;
  name: string;
  email: string | null;
  backupEmail: string | null;
  phone: string | null;
  company: string | null;
  licenseNumber: string | null;
  generalNotes: string | null;
  editingPreferences: string | null;
  clientPreferences: string | null;
  brandColors: string | null;
  brandAssetsPath: string | null;
  socialClient: boolean;
  socialPlan: string | null;
  aryeoCustomerId: string | null;
  updatedAt: Date;
  _count: { projects: number };
};

const CLIENT_SELECT = {
  id: true, name: true, email: true, backupEmail: true, phone: true, company: true,
  licenseNumber: true, generalNotes: true, editingPreferences: true, clientPreferences: true,
  brandColors: true, brandAssetsPath: true, socialClient: true, socialPlan: true,
  aryeoCustomerId: true, updatedAt: true,
  _count: { select: { projects: true } },
} as const;

/** Where the candidate list lives between runs — read by the (future) review UI. */
export const DEDUPE_CANDIDATES_KEY = "client_dedupe_candidates";

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Group candidate clients with a tiny union-find over phone + name|company keys.
// NOTE the phone key is a CANDIDATE signal only (see the header): it groups a
// couple sharing a line, an agent and their assistant on the office number, and
// a brokerage main line just as happily as it groups one person's two records.
function buildClusters(clients: DedupeClient[]): DedupeClient[][] {
  const parent = new Map<string, string>();
  clients.forEach((c) => parent.set(c.id, c.id));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const byPhone = new Map<string, string>();
  const byNameCo = new Map<string, string>();
  for (const c of clients) {
    const pk = phoneKey(c.phone);
    if (pk.length === 10) {
      const prev = byPhone.get(pk);
      if (prev) union(prev, c.id);
      else byPhone.set(pk, c.id);
    }
    const name = norm(c.name);
    const co = norm(c.company);
    if (name && co) {
      const k = `${name}|${co}`;
      const prev = byNameCo.get(k);
      if (prev) union(prev, c.id);
      else byNameCo.set(k, c.id);
    }
  }

  const groups = new Map<string, DedupeClient[]>();
  for (const c of clients) {
    const r = find(c.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(c);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export type DuplicateCandidate = {
  /** stable per set of clients — the decision task's dedupe key rides on this */
  key: string;
  clients: Array<{
    id: string;
    name: string;
    email: string | null;
    company: string | null;
    phone10: string;
    aryeoCustomerId: string | null;
    projects: number;
  }>;
  matchedOn: string[];
  /** why a machine must NOT merge this one — empty is still only a suggestion */
  blockers: string[];
};

// The evidence that says "two people", not "one person twice". Kept as text so
// the task card and the review UI show the human the same reason the rule saw.
function blockersFor(cluster: DedupeClient[]): string[] {
  const out: string[] = [];
  const aryeoIds = [...new Set(cluster.map((c) => c.aryeoCustomerId).filter(Boolean))];
  if (aryeoIds.length > 1) out.push(`${aryeoIds.length} separate Aryeo customer records`);
  const companies = [...new Set(cluster.map((c) => norm(c.company)).filter(Boolean))];
  if (companies.length > 1) out.push(`different companies (${cluster.map((c) => c.company).filter(Boolean).join(" / ")})`);
  const buyers = cluster.filter((c) => c._count.projects > 0);
  if (buyers.length > 1) out.push(`${buyers.length} of them have their own orders`);
  return out;
}

// Test records never earn an owner decision. "Bobby TEST Michael TEST" and two
// "John Doe" rows share Jordan's own phone with his two real client records, so
// the Sep 3 and Sep 4 scans each filed a "Possible duplicate clients — Jordan
// Spackman / Bobby TEST Michael TEST / John Doe" task for him (Sep 8 audit).
// Word-bounded so a real "Testa" or "Testani Realty" is not swept up with them.
// Dropping the test rows still leaves the real rows in the cluster to review.
export const TEST_CLIENT_NAME = /\btest\b|john doe/i;
const isTestClient = (c: { name: string }) => TEST_CLIENT_NAME.test(c.name);

/** Read-only: who LOOKS like a duplicate, and what the evidence says. */
export async function findDuplicateCandidates(): Promise<DuplicateCandidate[]> {
  const clients = ((await prisma.client.findMany({ select: CLIENT_SELECT })) as DedupeClient[]).filter((c) => !isTestClient(c));
  return buildClusters(clients).map((cluster) => {
    // Most orders first — the row a human would most likely keep.
    const sorted = [...cluster].sort(
      (a, b) => b._count.projects - a._count.projects || b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    const phones = new Set(sorted.map((c) => phoneKey(c.phone)).filter((p) => p.length === 10));
    const matchedOn: string[] = [];
    if (phones.size === 1) matchedOn.push("same phone number");
    if (new Set(sorted.map((c) => `${norm(c.name)}|${norm(c.company)}`)).size === 1) matchedOn.push("same name + company");
    return {
      key: sorted.map((c) => c.id).sort().join("+"),
      clients: sorted.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        company: c.company,
        phone10: phoneKey(c.phone),
        aryeoCustomerId: c.aryeoCustomerId,
        projects: c._count.projects,
      })),
      matchedOn,
      blockers: blockersFor(sorted),
    };
  });
}

/** The decision tasks' key prefix — `client-dupe-<candidate.key>`. */
const DUPE_TASK_PREFIX = "client-dupe-";
// Stamped on a decision task the SCAN closed (the cluster behind it changed),
// as opposed to one a human closed. Only these may be reopened by a later
// scan: a human's "they're different people" is final, the scan's own
// housekeeping is not.
const SUPERSEDED_MARKER = "superseded-by-scan";

/**
 * The nightly step. Records the candidates and files ONE decision task per
 * candidate for Jordan — it never merges. Two surfaces on purpose:
 *   • the SmartTask is where a human actually sees it (the board is already the
 *     place decisions land — same pattern as the "video marked not completable"
 *     decision task), minted with a stable dedupeKey and never re-opened once a
 *     human closed it, so a night that re-proposes the same pair can't re-open
 *     work someone handled;
 *   • the AppSetting row is the machine-readable list, with the evidence, for
 *     the approve-in-app merge flow to read (a task title can't carry ids). A
 *     candidate stays on that list after someone deals with it — its decision
 *     task (dedupeKey `client-dupe-<candidate.key>`) is what says it's handled.
 *
 * SUPERSEDED CLUSTERS (Sep 8 audit): the key is the member ids, so when a
 * cluster GROWS (a new signup lands on the same phone) tonight's task has a
 * new key and yesterday's stays open beside it — "Jordan Spackman / Bobby
 * TEST…" from Sep 3 sat under "Jordan Spackman / Jordan Spackman / Bobby
 * TEST…" from Sep 4, both OPEN on Jordan's list. Now every open decision task
 * whose key is not in tonight's candidate list is CANCELLED with a marker: the
 * rows behind it merged, vanished, or re-clustered, so the question it asked
 * no longer exists in that form. A task the scan cancelled that way is
 * reopened if the same cluster comes back; a task a human closed never is.
 *
 * The task is deliberately taskType "todo" with NO clientId — see the two
 * comments on the create below. Both are about keeping an owner-only decision
 * where only the owner can act on it; neither is cosmetic.
 *
 * `dryRun` does every read and no write — it returns exactly what a real run
 * would file and close, so the step can be checked against live data without
 * touching it.
 */
export async function reviewClientDuplicates(opts?: { dryRun?: boolean }): Promise<{
  candidates: number;
  blocked: number;
  tasksFiled: number;
  /** decision tasks closed (or, on a dry run, that would be) because their cluster is gone */
  superseded: string[];
  /** decision tasks created or reopened (or, on a dry run, that would be) */
  filed: string[];
}> {
  const dryRun = !!opts?.dryRun;
  const candidates = await findDuplicateCandidates();

  // Snapshot for the review UI. Best-effort: a settings write failure must not
  // lose the tasks below (the tasks are the part a human actually sees).
  if (!dryRun) {
    try {
      const value = JSON.stringify({
        at: new Date().toISOString(),
        // Bound it: the AppSetting value is one text column, and a list this long
        // means the matching rule broke, not that we have 200 real duplicates.
        candidates: candidates.slice(0, 50),
      });
      await prisma.appSetting.upsert({
        where: { key: DEDUPE_CANDIDATES_KEY },
        create: { key: DEDUPE_CANDIDATES_KEY, value, updatedBy: "cron:daily-clients" },
        update: { value, updatedBy: "cron:daily-clients" },
      });
    } catch (e) {
      console.warn("clientDedupe: candidate snapshot failed", e);
    }
  }

  // Close what tonight's list no longer asks. Done BEFORE filing so a cluster
  // that grew closes its old row and files its new one in the same pass.
  const currentKeys = new Set(candidates.map((c) => `${DUPE_TASK_PREFIX}${c.key}`));
  const superseded: string[] = [];
  const openDecisions = await prisma.smartTask.findMany({
    where: { dedupeKey: { startsWith: DUPE_TASK_PREFIX }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, title: true, dedupeKey: true, summary: true },
  });
  for (const t of openDecisions) {
    if (currentKeys.has(t.dedupeKey!)) continue;
    superseded.push(t.title);
    if (dryRun) continue;
    try {
      await prisma.smartTask.update({
        where: { id: t.id },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          sourceDetail: SUPERSEDED_MARKER,
          summary: `Closed by the nightly scan: the client records behind this one changed (merged, deleted, or re-clustered), so this exact question no longer exists — if the same people still look like one person there is a newer task for them. ${t.summary ?? ""}`.slice(0, 500),
        },
      });
    } catch (e) {
      console.warn("clientDedupe: could not close superseded task", t.dedupeKey, e);
    }
  }

  let tasksFiled = 0;
  const filed: string[] = [];
  for (const c of candidates) {
    const names = c.clients.map((x) => x.name);
    const dedupeKey = `${DUPE_TASK_PREFIX}${c.key}`;
    // Order matters: the summary is clipped at 500 chars, so the warning and the
    // evidence come first and the per-row detail (also on each client's page,
    // and in the AppSetting record) is what a long cluster loses.
    const evidence = [
      c.matchedOn.length ? `Matched on: ${c.matchedOn.join(", ")}.` : null,
      c.blockers.length
        ? `Against a merge: ${c.blockers.join("; ")}.`
        : "Nothing on the rows says these are two different people.",
      // Don't tell the owner to "merge by hand" — there is no merge in the app.
      // mergeClientsById() has zero callers and no UI, so the only two moves that
      // exist today are close-it or leave-it-open. Saying otherwise sends him
      // hunting for a button that isn't there. Kept short on purpose: it sits
      // ahead of the per-row detail in a summary clipped at 500 chars.
      "Nothing has been merged, and the app has no merge action yet. Different people: close this. Same person: leave it open — a merge is coming and this list feeds it.",
      c.clients.map((x) => `${x.name} — ${x.company ?? "no company"}, ${x.projects} order(s), ${x.email ?? "no email"}`).join(" · "),
    ].filter(Boolean).join(" ");
    const title = `Possible duplicate clients — ${names.join(" / ")}`.slice(0, 120);
    try {
      const prior = await prisma.smartTask.findUnique({
        where: { dedupeKey },
        select: { id: true, status: true, sourceDetail: true },
      });
      // One decision per pair — never re-open what a human closed. The only
      // row the scan may bring back is one the scan itself cancelled as
      // superseded (marker above); a cluster that split and re-formed is the
      // same question again, and a human never answered it.
      const reopen = !!prior && prior.status === "CANCELLED" && prior.sourceDetail === SUPERSEDED_MARKER;
      if (prior && !reopen) continue;
      filed.push(title);
      tasksFiled++;
      if (dryRun) continue;
      if (reopen) {
        await prisma.smartTask.update({
          where: { id: prior.id },
          data: { status: "OPEN", completedAt: null, sourceDetail: null, title, summary: evidence.slice(0, 500) },
        });
        continue;
      }
      await prisma.smartTask.create({
        data: {
          // "todo", NOT "internal_instruction" — two engines read that type and
          // would take this decision away from the owner:
          //   • opsDay.ts openLoopsList() pulls every open comms_followup /
          //     internal_instruction / callback / client_reply with no owner
          //     filter, so this landed in Kyle's and James's Open Loops behind a
          //     one-click "Handled". A stray click closes the pair forever — the
          //     next night never re-files a human-closed row.
          //   • brain.ts MERGEABLE_TYPES lists internal_instruction, so the comms
          //     router offered this task to the AI as a merge target and an
          //     inbound message could rewrite its title and summary out from
          //     under the decision (the Kristin case in the Sep 2 audit).
          // "todo" is in neither list, is swept by no reconciler, and still shows
          // on the /tasks board (boardVisibleWhere) where Jordan works. Closing it
          // stays a real decision ("they're different people"), so the nightly step
          // must NOT re-file a closed one — hence the type change, not a re-open.
          taskType: "todo",
          title,
          summary: evidence.slice(0, 500),
          reasonCreated: "Nightly duplicate-client scan found two client records that look like one person.",
          source: "system",
          priority: "MEDIUM",
          assignedKey: "jordan", // an owner data decision, not a queue job
          // No clientId on purpose. Belt-and-braces with the type above: a task
          // carrying a clientId is a candidate in routeCommTask's merge query
          // (`{ clientId, taskType in MERGEABLE_TYPES }`), and a client's next
          // text could then retitle this decision. It is also the honest shape —
          // the task is ABOUT a set of client rows, not filed under one of them,
          // and picking clients[0] was an arbitrary half-truth. Every id and name
          // already rides in the summary and in the AppSetting snapshot.
          dedupeKey,
        },
      });
    } catch (e) {
      console.warn("clientDedupe: could not file review task", dedupeKey, e);
    }
  }

  return {
    candidates: candidates.length,
    blocked: candidates.filter((c) => c.blockers.length > 0).length,
    tasksFiled,
    superseded,
    filed,
  };
}

/**
 * Merge a SPECIFIC set of client rows a human has approved (same person under a
 * team inbox / a second brokerage email — verified by a person or an audit).
 * Survivor = most projects, priority email = the one with the most projects
 * behind it.
 *
 * DESTRUCTIVE: it deletes the loser rows. Call it only from a human action —
 * no cron, sweep or listener may call it (see the header).
 */
export async function mergeClientsById(ids: string[]): Promise<{ ok: boolean; survivor?: string; message?: string }> {
  if (ids.length < 2) return { ok: false, message: "Need at least two clients to merge." };
  const cluster = (await prisma.client.findMany({ where: { id: { in: ids } }, select: CLIENT_SELECT })) as DedupeClient[];
  if (cluster.length !== ids.length) return { ok: false, message: "Some of those clients no longer exist." };

  // The content program hangs off clientId with NO foreign key, and two of its
  // tables are one-row-per-client (ContentEnrollment, AgentProfile). Re-pointing
  // both sides would collide on those unique columns and roll the whole merge
  // back; saying so up front is better than a P2002 in a human's face. (Before
  // this check the merge simply left every content row behind, orphaning an
  // enrolled client the moment its row was deleted.)
  const [enrollments, profiles] = await Promise.all([
    prisma.contentEnrollment.findMany({ where: { clientId: { in: ids } }, select: { clientId: true } }),
    prisma.agentProfile.findMany({ where: { clientId: { in: ids } }, select: { clientId: true } }),
  ]);
  if (enrollments.length > 1) {
    return { ok: false, message: "Both of these clients are enrolled in the content program. End or move one enrollment first — a merge can't decide which one survives." };
  }
  if (profiles.length > 1) {
    return { ok: false, message: "Both of these clients have an agent profile. Delete the one you don't want to keep first — a merge can't decide which one survives." };
  }

  const sorted = [...cluster].sort(
    (a, b) => b._count.projects - a._count.projects || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  const survivor = sorted[0];
  const losers = sorted.slice(1);
  const ranked = sorted.filter((c) => norm(c.email));
  const priorityEmail = ranked[0]?.email ?? survivor.email ?? null;
  const backupEmail =
    ranked.map((c) => c.email).find((e) => norm(e) && norm(e) !== norm(priorityEmail)) ?? survivor.backupEmail ?? null;
  const pick = <K extends keyof DedupeClient>(key: K): DedupeClient[K] => {
    if (survivor[key]) return survivor[key];
    for (const l of losers) if (l[key]) return l[key];
    return survivor[key];
  };
  const loserIds = losers.map((l) => l.id);
  await prisma.$transaction(async (tx) => {
    const to = { where: { clientId: { in: loserIds } }, data: { clientId: survivor.id } };
    await tx.project.updateMany(to);
    await tx.smartTask.updateMany(to);
    await tx.contact.updateMany(to);
    await tx.commLog.updateMany(to);
    // Content program + signups + owner to-dos: plain clientId refs (and, for
    // OwnerTodo, a SetNull FK) — nothing here errors when the client vanishes,
    // it just quietly loses the person it belonged to. Re-point them all.
    await tx.contentEnrollment.updateMany(to);
    await tx.contentMonth.updateMany(to);
    await tx.contentTopic.updateMany(to);
    await tx.contentScript.updateMany(to);
    await tx.contentNote.updateMany(to);
    await tx.contentStrategy.updateMany(to);
    await tx.agentProfile.updateMany(to);
    await tx.programSignup.updateMany(to);
    await tx.ownerTodo.updateMany(to);
    await tx.client.updateMany({ where: { parentClientId: { in: loserIds } }, data: { parentClientId: survivor.id } });
    // Delete the duplicates first so their unique aryeoCustomerId frees up.
    await tx.client.deleteMany({ where: { id: { in: loserIds } } });
    // Then apply the merged record to the survivor.
    await tx.client.update({
      where: { id: survivor.id },
      data: {
        email: priorityEmail,
        backupEmail,
        phone: pick("phone"),
        company: pick("company"),
        licenseNumber: pick("licenseNumber"),
        generalNotes: pick("generalNotes"),
        editingPreferences: pick("editingPreferences"),
        clientPreferences: pick("clientPreferences"),
        brandColors: pick("brandColors"),
        brandAssetsPath: pick("brandAssetsPath"),
        socialClient: survivor.socialClient || losers.some((l) => l.socialClient),
        socialPlan: pick("socialPlan"),
        aryeoCustomerId: pick("aryeoCustomerId"),
      },
    });
  });
  return { ok: true, survivor: survivor.id };
}
