import "server-only";
import { prisma } from "@/lib/prisma";
import type { PortalViewer } from "@/lib/portal";
import { actorLabel } from "@/lib/portalAccess";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// THE CLIENT'S VERDICT ON A SCRIPT (spec §22, F09) — Sep 22 2026.
//
// Until today a script had TWO gates and both of them were ours: Jordan
// approves a version, and releasing it is a separate act. The client read the
// words in their portal and had exactly one thing they could do about them —
// "Discuss", a free-text note against the TOPIC. So the person who has to stand
// in front of a camera and say these sentences had no way to say "yes, I'll
// film this" or "no, change this line", and nothing downstream could tell the
// difference between a script they had read and one they had agreed to.
//
// This is that third act. It is the client's, it is attributable to the actual
// person (never "the link"), and it is PINNED TO THE EXACT VERSION THEY READ —
// so an edit after their yes produces a new version that does not inherit it.
// That pinning is the whole point: approval of v2 is not approval of v3.
//
// WHAT IT DOES NOT DO.
//   · It does not approve or release anything. Staff approval stays staff's.
//   · It does not call a model. A change request is recorded and routed to a
//     person; the "revise with AI" button is still a human's click.
//   · It never deletes. A yes followed by a change request leaves both rows on
//     the ledger; only the CURRENT state changes.
//
// R1 + R2 (follow-up audit, Sep 22 2026). Three things were wrong and all three
// are closed here:
//
//   · THE DECISION WAS NOT PINNED TO WHAT THEY READ. The browser sent a script
//     id and the server took whatever sharedVersionId was current. A client with
//     v1 open, after v2 was released, pressed "I'll film this" and approved
//     words they had never seen. Both actions now REQUIRE the version the page
//     was showing and refuse politely when it has moved on — and the write is a
//     compare-and-swap against sharedVersionId, so a release landing mid-click
//     cannot be approved either.
//
//   · THREE SURFACES ANSWERED THE SAME QUESTION DIFFERENTLY. The portal and the
//     staff panel read the newest ledger row (correct). The photographer's
//     filming brief read `clientApprovedVersionId === sharedVersionId` — a
//     pointer a change request never cleared. So a client could ask for a change
//     and the person holding the camera would still be told they had signed off.
//     `currentScriptDecision` below is now the one rule, and filmedTopics reads it.
//
//   · A CHANGE REQUEST COULD LOSE ITS WORK ITEM. The ledger row, the staff work
//     item and the script stamp were three unrelated writes, and the duplicate
//     guard only looked at the ledger — so a failed ScriptSuggestion insert plus
//     a retry produced "it's with the writer" over an empty queue. They are one
//     transaction now, the retry REPAIRS a missing work item instead of
//     congratulating itself, and a sweep catches anything older.
//
// TWO RECORDS, DELIBERATELY, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
//   · ContentScriptRelease is the TIMELINE: every APPROVE, SHARE, and now
//     CLIENT_APPROVED / CLIENT_CHANGES, each with its actor and time.
//     actorClientUserId names the client — a column, not an inference from a
//     null actorAppUserId.
//   · ScriptSuggestion is the WORK ITEM, and it already exists with
//     clientUserId, scriptVersionId and an OPEN → APPLIED/DISMISSED staff flow
//     that the workspace reads today. A change request writes one, so it lands
//     in the queue Jordan already looks at rather than a second one nobody
//     opens. (The client-side box that used to write these,
//     components/portal/PortalSuggestBox.tsx, was built and never rendered
//     anywhere — the suggestion path has been reachable only by staff.)
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{10,40}$/i;

/** Matches OPEN_SUGGESTION_CAP in app/portal/actions.ts — the other path a client can file one from. */
const OPEN_SCRIPT_REQUEST_CAP = 15;

export type ScriptDecisionState = {
  /** The version the client is being asked about — the shared one, or null when nothing is shared. */
  sharedVersionId: string | null;
  sharedVersionNo: number | null;
  /** Their standing answer ON THAT VERSION. An older version's yes does not count. */
  decision: "APPROVED" | "CHANGES_REQUESTED" | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Their answer was about an EARLIER version — the words have changed since. */
  staleApproval: boolean;
  /** The change requests on record, newest first. Never removed. */
  requests: { at: string; by: string | null; note: string | null; versionNo: number | null }[];
};

/**
 * THE ONE RULE for "where does the client stand on this script", so the portal,
 * the staff panel and the photographer's filming brief cannot disagree.
 *
 * Newest ledger row wins, and only when it is about the version that is
 * CURRENTLY shared: an approval of v2 says nothing about v3. Ordered by
 * createdAt then id so two rows written in the same millisecond still resolve
 * the same way on every read.
 */
export function currentScriptDecision(
  sharedVersionId: string | null,
  ledger: { action: string; scriptVersionId: string; createdAt: Date; id: string; actorEmail: string | null }[],
): { decision: "APPROVED" | "CHANGES_REQUESTED" | null; at: Date | null; by: string | null } {
  if (!sharedVersionId) return { decision: null, at: null, by: null };
  const onShared = ledger
    .filter((r) => r.scriptVersionId === sharedVersionId && (r.action === "CLIENT_APPROVED" || r.action === "CLIENT_CHANGES"))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  const latest = onShared[0];
  if (!latest) return { decision: null, at: null, by: null };
  return { decision: latest.action === "CLIENT_APPROVED" ? "APPROVED" : "CHANGES_REQUESTED", at: latest.createdAt, by: latest.actorEmail };
}

/** What the portal needs to render the two buttons honestly, for several scripts at once. */
export async function scriptDecisionsFor(enrollmentId: string, scriptIds: string[]): Promise<Map<string, ScriptDecisionState>> {
  const out = new Map<string, ScriptDecisionState>();
  const ids = scriptIds.filter((id) => ID_RE.test(id));
  if (!ids.length) return out;
  const scripts = await prisma.contentScript.findMany({
    where: { id: { in: ids }, enrollmentId },
    select: { id: true, sharedVersionId: true, releaseState: true, clientApprovedVersionId: true, clientApprovedAt: true, clientChangesAt: true, clientApprovedByUserId: true },
  });
  if (!scripts.length) return out;
  const versionIds = [...new Set(scripts.flatMap((s) => [s.sharedVersionId, s.clientApprovedVersionId]).filter((x): x is string => !!x))];
  const versions = versionIds.length
    ? await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNo: true } })
    : [];
  const noOf = new Map(versions.map((v) => [v.id, v.versionNo]));
  // SCOPED TO THE VERSIONS THAT ARE ACTUALLY SHARED, not a global page.
  //
  // This was `take: 200` across EVERY script in the batch. loadScriptsTab hands
  // in every script on an enrollment and the portal hands in every live one, so
  // on a client with a long decision history the newest 200 rows could all
  // belong to the first few scripts and the rest would read as undecided.
  // currentScriptDecision only ever looks at rows about the CURRENT shared
  // version, so asking for exactly those is both correct and naturally bounded.
  const sharedIds = scripts.map((s) => s.sharedVersionId).filter((x): x is string => !!x);
  const ledger = sharedIds.length
    ? await prisma.contentScriptRelease.findMany({
        where: { scriptId: { in: scripts.map((s) => s.id) }, scriptVersionId: { in: sharedIds }, action: { in: ["CLIENT_APPROVED", "CLIENT_CHANGES"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true, scriptId: true, action: true, createdAt: true, note: true, scriptVersionId: true, actorEmail: true },
      })
    : [];
  // The change-request HISTORY the panel lists is a separate, bounded read —
  // it spans older versions on purpose, and must not compete for the same page.
  const history = await prisma.contentScriptRelease.findMany({
    where: { scriptId: { in: scripts.map((s) => s.id) }, action: "CLIENT_CHANGES" },
    orderBy: { createdAt: "desc" },
    select: { scriptId: true, createdAt: true, note: true, scriptVersionId: true, actorEmail: true },
    take: 100,
  });

  for (const s of scripts) {
    const rows = ledger.filter((r) => r.scriptId === s.id);
    // THE ONE RULE (R1). This used to take the newest row for the SCRIPT and
    // then ask whether it happened to be about the shared version — which is
    // the same answer in the ordinary case and quietly different the moment a
    // decision exists on more than one version. currentScriptDecision filters
    // to the shared version first.
    // A script pulled back off the portal has no CURRENT client decision, for
    // the same reason sharedScriptFor refuses to accept one: the client cannot
    // see the words. Without this, returnScriptToQueue left "client signed off"
    // on the staff chip and on the photographer's brief for a script nobody
    // outside the office could read any more.
    const live = s.releaseState === "released";
    const current = live ? currentScriptDecision(s.sharedVersionId, rows) : { decision: null, at: null, by: null };
    const approvedOnShared = live && !!s.sharedVersionId && s.clientApprovedVersionId === s.sharedVersionId;
    out.set(s.id, {
      sharedVersionId: s.sharedVersionId,
      sharedVersionNo: s.sharedVersionId ? noOf.get(s.sharedVersionId) ?? null : null,
      decision: current.decision,
      decidedAt: current.at?.toISOString() ?? null,
      decidedBy: current.by,
      staleApproval: !!s.clientApprovedVersionId && !approvedOnShared,
      requests: history
        .filter((r) => r.scriptId === s.id)
        .map((r) => ({ at: r.createdAt.toISOString(), by: r.actorEmail, note: r.note, versionNo: noOf.get(r.scriptVersionId) ?? null })),
    });
  }
  return out;
}

type Outcome =
  | { ok: true; duplicate: boolean; message: string; repaired?: boolean }
  /** R1: the page was showing a version that is no longer the shared one. Not a failure — a refresh. */
  | { ok: false; message: string; stale?: boolean };

/** The shared version of a script that belongs to this viewer's enrollment, or a refusal. */
async function sharedScriptFor(viewer: PortalViewer, scriptId: string) {
  if (!ID_RE.test(scriptId)) return null;
  const s = await prisma.contentScript.findUnique({
    where: { id: scriptId },
    select: { id: true, enrollmentId: true, clientId: true, monthId: true, title: true, historical: true, releaseState: true, sharedVersionId: true, clientApprovedVersionId: true },
  });
  if (!s || s.enrollmentId !== viewer.enrollment.id || s.clientId !== viewer.enrollment.clientId) return null;
  if (s.historical) return null; // an old script we hold is not this month's script
  if (!s.sharedVersionId || s.releaseState !== "released") return null;
  return s;
}

const stampActor = (v: PortalViewer) => ({
  actorClientUserId: v.actor.kind === "CLIENT" ? v.actor.clientUserId : null,
  actorEmail: actorLabel(v),
});

/**
 * "Yes — I'll film this." Pinned to the shared version.
 *
 * Idempotent on the pair (script, version): pressing it twice is one row, and
 * the second press says so rather than pretending a second approval happened.
 */
export async function clientApproveScript(viewer: PortalViewer, scriptId: string, readVersionId: string): Promise<Outcome> {
  if (viewer.access !== "FULL") return { ok: false, message: "Your access is read-only right now — text us and we'll sort it." };
  const s = await sharedScriptFor(viewer, scriptId);
  if (!s) return { ok: false, message: "That script isn't on your page." };
  const versionId = s.sharedVersionId!;
  // R1 — THE DECISION IS ABOUT THE WORDS THEY READ, NOT THE WORDS THAT ARE
  // CURRENT. The page sends back the version it rendered. If a new one has been
  // released since, this is a stale tab and there is nothing to be sorry about:
  // ask them to read it.
  if (!readVersionId || readVersionId !== versionId) return staleRefusal(readVersionId);

  // WHERE THEY STAND RIGHT NOW, by the one rule. Not "is there an approval row
  // somewhere in the history": a client can approve, ask for a change, and
  // approve again, and each of those is a real decision that has to reach the
  // timeline. An earlier version of this fix skipped the ledger write whenever
  // ANY approval row existed for the version — so a change of mind never got a
  // row, currentScriptDecision kept reading the change request as newest, and
  // the portal, the staff panel and the filming brief all stayed wrong. Caught
  // by scripts/_drill/r1-r2-script-decisions.ts.
  const priorLedger = await prisma.contentScriptRelease.findMany({
    where: { scriptId: s.id, action: { in: ["CLIENT_APPROVED", "CLIENT_CHANGES"] } },
    select: { id: true, action: true, scriptVersionId: true, createdAt: true, actorEmail: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (currentScriptDecision(versionId, priorLedger).decision === "APPROVED") {
    return { ok: true, duplicate: true, message: "You've already signed off on this version — nothing more to do." };
  }
  // Are they overturning their own change request on this same version? Allowed
  // — people do change their mind — but never silently: the writer may already
  // be working on it, and both sides have to be told.
  const openRequest = await prisma.scriptSuggestion.findFirst({
    where: { scriptId: s.id, scriptVersionId: versionId, status: "OPEN" },
    select: { id: true },
  });
  const now = new Date();
  // One transaction, and the script write is a COMPARE-AND-SWAP on
  // sharedVersionId: a release landing between the read above and this write
  // changes the row out from under us, the update matches nothing, and the
  // whole thing rolls back rather than recording an approval of words nobody
  // has read.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.contentScriptRelease.create({
        data: {
          scriptId: s.id, scriptVersionId: versionId, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId,
          action: "CLIENT_APPROVED", ...stampActor(viewer),
          note: openRequest ? "Client signed off as written, overturning their own open change request." : "Client signed off on the shared version.",
        },
      });
      const swapped = await tx.contentScript.updateMany({
        where: { id: s.id, sharedVersionId: versionId },
        data: {
          clientApprovedVersionId: versionId,
          clientApprovedAt: now,
          clientApprovedByUserId: viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : null,
          // Their earlier "change this" on this same version is answered by
          // this yes. The LEDGER keeps it — what is cleared is the current
          // state, exactly as returnScriptToQueue treats staff approval.
          clientChangesAt: null,
        },
      });
      if (swapped.count === 0) throw new StaleReleaseError();
    });
  } catch (e) {
    if (e instanceof StaleReleaseError) return staleRefusal(readVersionId);
    throw e;
  }
  return {
    ok: true,
    duplicate: false,
    message: openRequest
      ? "Got it — we'll film this one as written. You'd asked for a change on it, so we've told the team you're happy with it as it stands."
      : "Got it — we'll film this one as written.",
  };
}

class StaleReleaseError extends Error {
  constructor() {
    super("the shared version moved while this decision was being written");
    this.name = "StaleReleaseError";
  }
}

const staleRefusal = (readVersionId: string | null): Outcome => ({
  ok: false,
  stale: true,
  message: readVersionId
    ? "We've published a newer version of this script since this page loaded. Refresh and have a read — we'd rather you decide on the words we'd actually film."
    : "Refresh the page and try again — we couldn't tell which version you were looking at.",
});

/** A short stable digest of a note, for a bell key that distinguishes instructions. */
function sha16(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A person has to see it. Best-effort — a missed bell is not a lost instruction, because the row is. */
async function bellForChangeRequest(
  viewer: PortalViewer,
  s: { id: string; enrollmentId: string; title: string },
  versionId: string,
  body: string,
  by: string,
  /** "repair" = the work item had gone missing and was re-filed. Nobody has seen
   *  this instruction, so it rings again under its own key rather than being
   *  swallowed by the bell the lost attempt already fired. */
  reason: "new" | "repair" = "new",
): Promise<void> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "script_change_request",
      title: `${reason === "repair" ? "Script change RE-FILED" : "Script change asked for"} — ${viewer.enrollment.clientName || "a client"}`,
      body: `${reason === "repair" ? "This request was missing from the queue and has been put back. " : ""}${by} on "${s.title}": ${clip(body, 140)}`,
      href: `/content/${s.enrollmentId}?tab=scripts`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      // Keyed on the WORDS as well as the version: a burst of identical text
      // rings once, but a second, different instruction on the same version is
      // a second thing the writer has to know about.
      dedupeKey: `script-changes-${s.id}-${versionId}-${sha16(body)}${reason === "repair" ? "-repair" : ""}`,
    });
  } catch {
    /* the ledger row and the work item are the record */
  }
}

/**
 * "Change this." Recorded against the exact version, routed to a person.
 *
 * Deliberately NOT an AI call. The instruction is a durable row first; a
 * person then presses "revise with AI" or rewrites it by hand. A05 is the
 * lesson here — a revision instruction that lives only inside a generated
 * brief is an instruction that can be overwritten by the next one.
 */
export async function clientRequestScriptChanges(viewer: PortalViewer, scriptId: string, note: string, readVersionId: string): Promise<Outcome> {
  if (viewer.access !== "FULL") return { ok: false, message: "Your access is read-only right now — text us and we'll sort it." };
  const s = await sharedScriptFor(viewer, scriptId);
  if (!s) return { ok: false, message: "That script isn't on your page." };
  const body = clip((note ?? "").trim(), 2000);
  if (body.length < 3) return { ok: false, message: "Tell us what to change — a line, a word, the whole angle." };
  const versionId = s.sharedVersionId!;
  // R1: same rule as the approval. A note about v1 must not be filed against v2.
  if (!readVersionId || readVersionId !== versionId) return staleRefusal(readVersionId);

  const by = actorLabel(viewer);

  // THE SAME CAP THE OTHER CLIENT-WRITE PATH CARRIES. portalSuggestScript has
  // refused past fifteen open suggestions in thirty days since it was written;
  // this path had no cap at all, only the ten-minute identical-text throttle —
  // so a frustrated client could fill the writer's queue one distinct sentence
  // at a time. Same number, same words, so the two behave alike.
  const openCount = await prisma.scriptSuggestion.count({
    where: { enrollmentId: s.enrollmentId, status: "OPEN", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  });
  if (openCount >= OPEN_SCRIPT_REQUEST_CAP) {
    return { ok: false, message: "You have a lot of change requests in already — we're on them! Text us if this one is urgent." };
  }

  // R2 — THE DUPLICATE GUARD IS NOW A REPAIR PATH.
  //
  // A second request on the SAME version is a second instruction, not a
  // duplicate: people remember one more thing a minute later, and losing the
  // second note is exactly the failure this exists to prevent. What is
  // throttled is a burst of IDENTICAL text.
  //
  // Two things changed. The match is EXACT rather than "ends with the last 120
  // characters", so two genuinely different notes that happen to finish the
  // same way stay distinct. And finding the ledger row is no longer the end of
  // it: the whole point of the retry is that something did not land last time,
  // so we check the WORK ITEM too and make it if it is missing. Telling a
  // client "it's with the writer" over an empty queue is the defect.
  const dupe = await prisma.contentScriptRelease.findFirst({
    where: { scriptId: s.id, scriptVersionId: versionId, action: "CLIENT_CHANGES", note: body, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    select: { id: true },
  });
  if (dupe) {
    const item = await prisma.scriptSuggestion.findFirst({ where: { scriptId: s.id, scriptVersionId: versionId, body }, select: { id: true } });
    if (item) return { ok: true, duplicate: true, message: "We already have that note — it's with the writer." };
    // The ledger has it and the queue does not. Repair, then say so honestly.
    await prisma.scriptSuggestion.create({
      data: {
        scriptId: s.id, enrollmentId: s.enrollmentId, scriptVersionId: versionId, body,
        clientUserId: viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : null,
        staffUserId: viewer.actor.kind === "STAFF" ? viewer.actor.staffUserId : null,
      },
    });
    await prisma.contentScript.update({ where: { id: s.id }, data: { clientChangesAt: new Date() } }).catch(() => {});
    await bellForChangeRequest(viewer, s, versionId, body, by, "repair");
    return { ok: true, duplicate: true, repaired: true, message: "Sent — we'll rework it and share the new version here." };
  }

  // R2 — ONE TRANSACTION. The ledger row, the work item staff act on, and the
  // script's own stamp were three unrelated writes; the middle one failing left
  // a client told their words were with the writer and a queue with nothing in
  // it. They land together or not at all.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.contentScriptRelease.create({
        data: {
          scriptId: s.id, scriptVersionId: versionId, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId,
          action: "CLIENT_CHANGES", ...stampActor(viewer), note: body,
        },
      });
      // The work item, in the queue staff already work from, pinned to the
      // version they are asking about so a note on v2 is never applied blind to v4.
      await tx.scriptSuggestion.create({
        data: {
          scriptId: s.id, enrollmentId: s.enrollmentId, scriptVersionId: versionId, body,
          clientUserId: viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : null,
          staffUserId: viewer.actor.kind === "STAFF" ? viewer.actor.staffUserId : null,
        },
      });
      // Compare-and-swap, same reason as the approval: a release landing
      // mid-click must not take this note with it.
      const swapped = await tx.contentScript.updateMany({
        where: { id: s.id, sharedVersionId: versionId },
        data: {
          clientChangesAt: new Date(),
          // This answers their earlier yes on the same version. The ledger
          // keeps both; the pointer is current authorisation, not history.
          clientApprovedVersionId: null,
          clientApprovedAt: null,
          clientApprovedByUserId: null,
        },
      });
      if (swapped.count === 0) throw new StaleReleaseError();
    });
  } catch (e) {
    if (e instanceof StaleReleaseError) return staleRefusal(readVersionId);
    throw e;
  }

  await bellForChangeRequest(viewer, s, versionId, body, by);
  return { ok: true, duplicate: false, message: "Sent — we'll rework it and share the new version here." };
}

// `openScriptChangeRequests` USED TO LIVE HERE and had no caller anywhere in
// the tree. It was a correctly-scoped read of OPEN ScriptSuggestion rows that
// no page imported — and the follow-up audit read it as the staff queue, which
// is exactly the harm a plausible dead function does. The real staff queue is
// the inline read in src/app/content/[id]/page.tsx (OPEN ScriptSuggestion rows
// grouped per script, rendered by ScriptReview). Deleted rather than wired,
// because a second reader of the same rows is a second thing to keep in step.

// ---------------------------------------------------------------------------
// R2 — THE WATCHER, for anything the transaction above cannot cover.
//
// The three writes are atomic now, so a NEW request cannot half-land. Two
// things are still outside that guarantee and both are real:
//   · rows written before this fix, when the writes were unordered;
//   · a client who never retries, so the repair path in
//     clientRequestScriptChanges is never reached.
//
// Same shape as repairApprovedCutLibrary: ask the one question that matters —
// which CLIENT_CHANGES ledger rows have no work item — and make the missing
// ones. Normally it repairs nothing.
//
// It will NOT invent a client request. A ledger row is the client's own words
// with their own actor on it; this only re-files what they already said.
// ---------------------------------------------------------------------------
export async function repairScriptChangeRequests(opts: { sinceDays?: number; max?: number } = {}): Promise<{
  checked: number;
  repaired: number;
  failed: number;
  lastError: string | null;
  detail: { scriptId: string; versionId: string; at: string }[];
}> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 90) * 86_400_000);
  const asks = await prisma.contentScriptRelease.findMany({
    where: { action: "CLIENT_CHANGES", createdAt: { gte: since } },
    select: { id: true, scriptId: true, scriptVersionId: true, enrollmentId: true, note: true, createdAt: true, actorClientUserId: true },
    orderBy: { createdAt: "desc" },
    take: opts.max ?? 300,
  });
  if (!asks.length) return { checked: 0, repaired: 0, failed: 0, lastError: null, detail: [] };

  // Every suggestion that already exists for the scripts in play, in one read.
  const existing = await prisma.scriptSuggestion.findMany({
    where: { scriptId: { in: [...new Set(asks.map((a) => a.scriptId))] } },
    select: { scriptId: true, scriptVersionId: true, body: true },
  });
  const seen = new Set(existing.map((e) => `${e.scriptId}|${e.scriptVersionId ?? ""}|${e.body}`));

  let repaired = 0, failed = 0;
  let lastError: string | null = null;
  const detail: { scriptId: string; versionId: string; at: string }[] = [];
  for (const a of asks) {
    if (!a.note) continue; // a ledger row with no words is not a work item
    const key = `${a.scriptId}|${a.scriptVersionId}|${a.note}`;
    if (seen.has(key)) continue;
    try {
      await prisma.scriptSuggestion.create({
        data: { scriptId: a.scriptId, enrollmentId: a.enrollmentId, scriptVersionId: a.scriptVersionId, body: a.note, clientUserId: a.actorClientUserId },
      });
      seen.add(key);
      repaired++;
      detail.push({ scriptId: a.scriptId, versionId: a.scriptVersionId, at: a.createdAt.toISOString() });
    } catch (e) {
      failed++;
      lastError = e instanceof Error ? e.message.slice(0, 200) : "unknown";
    }
  }
  if (repaired > 0) {
    console.info(`[scripts] ${repaired} client change request(s) had no work item in the queue and were re-filed — the client had been told it was with the writer.`);
  }
  return { checked: asks.length, repaired, failed, lastError, detail };
}
