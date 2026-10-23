import { prisma } from "@/lib/prisma";
import { LEGACY_CLIENT_STATUSES, rewriteRefusal, type RewriteFacts } from "@/lib/scriptRewriteRule";

// ---------------------------------------------------------------------------
// "WRITE IT AGAIN" ON THE SERVER (Oct 23 2026). The rule is scriptRewriteRule;
// this reads the facts it needs from the database, once when the button is
// pressed (content/actions queueScriptRewriteAction) and once more when the
// queued job reaches the front (aiQueue), before any model call, so a script
// sent to the client while the job waited is never written again.
// ---------------------------------------------------------------------------

export type RewriteTarget = { id: string; title: string; enrollmentId: string; clientId: string; topicId: string; monthId: string; callRecordId: string | null };

/** Thrown by the queued job when the script may no longer be written again (the message is the plain reason). */
export class RewriteRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "RewriteRefusedError"; }
}

/** The facts the rule reads, for one script (null when it is gone). */
export async function rewriteFactsFor(scriptId: string): Promise<{ facts: RewriteFacts; script: { id: string; title: string; enrollmentId: string; clientId: string; topicId: string | null; monthId: string | null; callRecordId: string | null } } | null> {
  const s = await prisma.contentScript.findUnique({
    where: { id: String(scriptId ?? "") },
    select: {
      id: true, title: true, enrollmentId: true, clientId: true, topicId: true, monthId: true, callRecordId: true, videoId: true,
      historical: true, status: true, clientVisible: true, releaseState: true, sharedVersionId: true, sharedAt: true, clientApprovedVersionId: true, clientApprovedAt: true,
    },
  });
  if (!s) return null;
  const { readScriptsFilmed } = await import("@/lib/scriptFilmed");
  const [sharedVersion, ledger, filmed, bulk] = await Promise.all([
    prisma.contentScriptVersion.findFirst({ where: { scriptId: s.id, OR: [{ sharedAt: { not: null } }, { status: "SHARED" }] }, select: { id: true } }),
    prisma.contentScriptRelease.findMany({ where: { scriptId: s.id, OR: [{ action: { in: ["SHARE", "APPROVE_AND_SHARE", "UPDATE_SHARED", "CLIENT_APPROVED"] } }, { releasedAt: { not: null } }] }, select: { action: true } }),
    readScriptsFilmed([{ id: s.id, topicId: s.topicId, videoId: s.videoId }]),
    // A bulk plan's month holds the client's own bank (programData's bulkBank).
    s.monthId ? prisma.contentBulkPlan.findFirst({ where: { monthId: s.monthId, status: { not: "CANCELLED" } }, select: { id: true } }) : Promise.resolve(null),
  ]);
  const facts: RewriteFacts = {
    historical: s.historical || s.releaseState === "historical",
    filmed: filmed.has(s.id),
    clientApproved: !!s.clientApprovedVersionId || !!s.clientApprovedAt || ledger.some((l) => l.action === "CLIENT_APPROVED"),
    everShared: !!s.sharedVersionId || !!s.sharedAt || s.clientVisible || (LEGACY_CLIENT_STATUSES as readonly string[]).includes(s.status) || !!sharedVersion || ledger.some((l) => l.action !== "CLIENT_APPROVED"),
    bulkBank: !!bulk,
    hasTopic: !!s.topicId,
    hasMonth: !!s.monthId,
  };
  return { facts, script: { id: s.id, title: s.title, enrollmentId: s.enrollmentId, clientId: s.clientId, topicId: s.topicId, monthId: s.monthId, callRecordId: s.callRecordId } };
}

/**
 * The script "Write it again" lands on, or the plain reason it is refused.
 * Beyond the rule: the topic's draft for that month must land on THIS script
 * (generateScriptForTopic writes onto the month's one live script for the
 * topic), so a topic with two live scripts that month is refused rather than
 * guessed at.
 */
export async function checkRewrite(scriptId: string): Promise<{ ok: true; script: RewriteTarget } | { ok: false; message: string }> {
  const r = await rewriteFactsFor(scriptId);
  if (!r) return { ok: false, message: "That script no longer exists." };
  const why = rewriteRefusal(r.facts);
  if (why) return { ok: false, message: why };
  const { script: s } = r;
  const siblings = await prisma.contentScript.count({ where: { topicId: s.topicId!, monthId: s.monthId!, historical: false } });
  if (siblings !== 1) return { ok: false, message: "This topic has more than one script this month, so a fresh draft could land on the other one. Use Edit or Ask AI to revise instead." };
  return { ok: true, script: { ...s, topicId: s.topicId!, monthId: s.monthId! } };
}

/** The queued job's own check, just before the writer runs: throws the plain reason. */
export async function assertRewritable(scriptId: string): Promise<RewriteTarget> {
  const r = await checkRewrite(scriptId);
  if (!r.ok) throw new RewriteRefusedError(r.message);
  return r.script;
}
