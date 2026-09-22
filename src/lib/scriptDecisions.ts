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

/** What the portal needs to render the two buttons honestly, for several scripts at once. */
export async function scriptDecisionsFor(enrollmentId: string, scriptIds: string[]): Promise<Map<string, ScriptDecisionState>> {
  const out = new Map<string, ScriptDecisionState>();
  const ids = scriptIds.filter((id) => ID_RE.test(id));
  if (!ids.length) return out;
  const scripts = await prisma.contentScript.findMany({
    where: { id: { in: ids }, enrollmentId },
    select: { id: true, sharedVersionId: true, clientApprovedVersionId: true, clientApprovedAt: true, clientChangesAt: true, clientApprovedByUserId: true },
  });
  if (!scripts.length) return out;
  const versionIds = [...new Set(scripts.flatMap((s) => [s.sharedVersionId, s.clientApprovedVersionId]).filter((x): x is string => !!x))];
  const versions = versionIds.length
    ? await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, versionNo: true } })
    : [];
  const noOf = new Map(versions.map((v) => [v.id, v.versionNo]));
  const ledger = await prisma.contentScriptRelease.findMany({
    where: { scriptId: { in: scripts.map((s) => s.id) }, action: { in: ["CLIENT_APPROVED", "CLIENT_CHANGES"] } },
    orderBy: { createdAt: "desc" },
    select: { scriptId: true, action: true, createdAt: true, note: true, scriptVersionId: true, actorEmail: true },
    take: 200,
  });

  for (const s of scripts) {
    const rows = ledger.filter((r) => r.scriptId === s.id);
    const latest = rows[0] ?? null;
    // "Decided" means decided ABOUT THE SHARED VERSION. Anything else is stale.
    const onShared = !!s.sharedVersionId && latest?.scriptVersionId === s.sharedVersionId;
    const approvedOnShared = !!s.sharedVersionId && s.clientApprovedVersionId === s.sharedVersionId;
    out.set(s.id, {
      sharedVersionId: s.sharedVersionId,
      sharedVersionNo: s.sharedVersionId ? noOf.get(s.sharedVersionId) ?? null : null,
      decision: onShared ? (latest!.action === "CLIENT_APPROVED" ? "APPROVED" : "CHANGES_REQUESTED") : null,
      decidedAt: onShared ? latest!.createdAt.toISOString() : null,
      decidedBy: onShared ? latest!.actorEmail : null,
      staleApproval: !!s.clientApprovedVersionId && !approvedOnShared,
      requests: rows
        .filter((r) => r.action === "CLIENT_CHANGES")
        .map((r) => ({ at: r.createdAt.toISOString(), by: r.actorEmail, note: r.note, versionNo: noOf.get(r.scriptVersionId) ?? null })),
    });
  }
  return out;
}

type Outcome = { ok: true; duplicate: boolean; message: string } | { ok: false; message: string };

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
export async function clientApproveScript(viewer: PortalViewer, scriptId: string): Promise<Outcome> {
  if (viewer.access !== "FULL") return { ok: false, message: "Your access is read-only right now — text us and we'll sort it." };
  const s = await sharedScriptFor(viewer, scriptId);
  if (!s) return { ok: false, message: "That script isn't on your page." };
  const versionId = s.sharedVersionId!;
  if (s.clientApprovedVersionId === versionId) {
    return { ok: true, duplicate: true, message: "You've already signed off on this version — nothing more to do." };
  }
  const already = await prisma.contentScriptRelease.findFirst({ where: { scriptId: s.id, scriptVersionId: versionId, action: "CLIENT_APPROVED" }, select: { id: true } });
  const now = new Date();
  if (!already) {
    await prisma.contentScriptRelease.create({
      data: {
        scriptId: s.id, scriptVersionId: versionId, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId,
        action: "CLIENT_APPROVED", ...stampActor(viewer), note: "Client signed off on the shared version.",
      },
    });
  }
  await prisma.contentScript.update({
    where: { id: s.id },
    data: { clientApprovedVersionId: versionId, clientApprovedAt: now, clientApprovedByUserId: viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : null },
  });
  return { ok: true, duplicate: !!already, message: "Got it — we'll film this one as written." };
}

/**
 * "Change this." Recorded against the exact version, routed to a person.
 *
 * Deliberately NOT an AI call. The instruction is a durable row first; a
 * person then presses "revise with AI" or rewrites it by hand. A05 is the
 * lesson here — a revision instruction that lives only inside a generated
 * brief is an instruction that can be overwritten by the next one.
 */
export async function clientRequestScriptChanges(viewer: PortalViewer, scriptId: string, note: string): Promise<Outcome> {
  if (viewer.access !== "FULL") return { ok: false, message: "Your access is read-only right now — text us and we'll sort it." };
  const s = await sharedScriptFor(viewer, scriptId);
  if (!s) return { ok: false, message: "That script isn't on your page." };
  const body = clip((note ?? "").trim(), 2000);
  if (body.length < 3) return { ok: false, message: "Tell us what to change — a line, a word, the whole angle." };
  const versionId = s.sharedVersionId!;

  // A second request on the SAME version is a second instruction, not a
  // duplicate: people remember one more thing a minute later, and losing the
  // second note is exactly the failure this is meant to prevent. What is
  // throttled is a burst of identical text.
  const dupe = await prisma.contentScriptRelease.findFirst({
    where: { scriptId: s.id, scriptVersionId: versionId, action: "CLIENT_CHANGES", note: { endsWith: body.slice(-120) }, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    select: { id: true },
  });
  if (dupe) return { ok: true, duplicate: true, message: "We already have that note — it's with the writer." };

  const by = actorLabel(viewer);
  await prisma.contentScriptRelease.create({
    data: {
      scriptId: s.id, scriptVersionId: versionId, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId,
      action: "CLIENT_CHANGES", ...stampActor(viewer), note: body,
    },
  });
  // The work item, in the queue staff already work from, pinned to the version
  // they are asking about so a note on v2 is never applied blind to v4.
  await prisma.scriptSuggestion.create({
    data: {
      scriptId: s.id, enrollmentId: s.enrollmentId, scriptVersionId: versionId, body,
      clientUserId: viewer.actor.kind === "CLIENT" ? viewer.actor.clientUserId : null,
      staffUserId: viewer.actor.kind === "STAFF" ? viewer.actor.staffUserId : null,
    },
  });
  await prisma.contentScript.update({ where: { id: s.id }, data: { clientChangesAt: new Date() } });

  // A person has to see it. The bell is best-effort; the row above is not.
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "script_change_request",
      title: `Script change asked for — ${viewer.enrollment.clientName || "a client"}`,
      body: `${by} on "${s.title}": ${clip(body, 140)}`,
      href: `/content/${s.enrollmentId}?tab=scripts`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `script-changes-${s.id}-${versionId}`,
    });
  } catch {
    /* the ledger row is the record; a missed bell is not a lost instruction */
  }
  return { ok: true, duplicate: false, message: "Sent — we'll rework it and share the new version here." };
}

/**
 * The change requests still open on this enrollment's scripts.
 *
 * Reads ScriptSuggestion, which is where the staff apply/dismiss flow already
 * lives — so an instruction cannot go quiet in a second queue nobody opens.
 */
export async function openScriptChangeRequests(enrollmentId: string): Promise<
  { scriptId: string; title: string; versionNo: number | null; at: string; note: string }[]
> {
  const rows = await prisma.scriptSuggestion.findMany({
    where: { enrollmentId, status: "OPEN" },
    orderBy: { createdAt: "desc" },
    select: { scriptId: true, scriptVersionId: true, createdAt: true, body: true },
    take: 50,
  });
  if (!rows.length) return [];
  const [scripts, versions] = await Promise.all([
    prisma.contentScript.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.scriptId))] } }, select: { id: true, title: true } }),
    prisma.contentScriptVersion.findMany({ where: { id: { in: rows.map((r) => r.scriptVersionId).filter((x): x is string => !!x) } }, select: { id: true, versionNo: true } }),
  ]);
  const titleOf = new Map(scripts.map((s) => [s.id, s.title]));
  const noOf = new Map(versions.map((v) => [v.id, v.versionNo]));
  return rows.map((r) => ({
    scriptId: r.scriptId,
    title: titleOf.get(r.scriptId) ?? "(script)",
    versionNo: r.scriptVersionId ? noOf.get(r.scriptVersionId) ?? null : null,
    at: r.createdAt.toISOString(),
    note: r.body,
  }));
}
