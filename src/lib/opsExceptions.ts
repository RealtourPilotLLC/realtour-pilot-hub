import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE EXCEPTIONS BOARD (R08, review Sep 18).
//
// Five things that go wrong quietly, each with a NAME on it and one sentence
// saying what to do. The board already had a Radar — three strategic risks,
// deliberately capped — and it was never meant to carry this: a job nobody has
// assigned, a cut nobody has ruled on, a chase date that has passed, a render
// stuck at the provider, a corrected video sitting approved and unsent. None of
// those is a strategic risk. Each is a specific thing somebody has to do.
//
// TWO RULES this file keeps:
//   · EVERY ROW HAS AN OWNER AND A NEXT ACTION. An exception nobody owns is a
//     worry, not a task, and worries accumulate until people stop reading the
//     card. Where the owner is genuinely unknown the row says "nobody yet",
//     which IS the exception in the unassigned case.
//   · IT ONLY EVER REPORTS. Nothing here writes a status, sends a message,
//     re-delivers a file or contacts a client — the same rule the delivery
//     reconciliation keeps, and for the same reason.
// ---------------------------------------------------------------------------

export type ExceptionKind =
  | "unassigned"
  | "aging-review"
  | "overdue-followup"
  | "stalled-render"
  | "unsent-replacement";

export type OpsException = {
  id: string;
  kind: ExceptionKind;
  severity: "high" | "medium";
  /** the thing, named — an address or a person, never a row id */
  title: string;
  /** why it is on this list, in one clause */
  why: string;
  /** who has to move it. "Nobody yet" is a real answer and its own exception. */
  owner: string;
  /** the single next action, in the imperative */
  nextAction: string;
  href: string;
  /** how long it has been like this */
  ageDays: number;
};

export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  unassigned: "Nobody assigned",
  "aging-review": "Waiting on a verdict",
  "overdue-followup": "Follow-up date passed",
  "stalled-render": "Render stuck at the provider",
  "unsent-replacement": "Approved replacement, not sent",
};

const DAY = 86_400_000;
const ageOf = (d: Date | null | undefined, now: number) => (d ? Math.max(0, Math.floor((now - d.getTime()) / DAY)) : 0);
const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "A job";

/** Thresholds, in one place so a person can argue with them. Deliberately
 *  generous: a board that fires on everything is a board nobody reads. */
export const EXCEPTION_RULES = {
  /** a cut with no verdict after this many days */
  reviewAgingDays: 3,
  /** a provider job with no movement for this many hours */
  renderStalledHours: 4,
  /** a corrected video approved and unsent for this many days */
  unsentDays: 1,
  /** how many rows of each kind, so one bad kind cannot crowd the rest out */
  perKind: 4,
};

export type CreativeApprover = {
  id: string;
  name: string;
  /** where the name came from — a designation, or a flag set for something else */
  from: "designated" | "creative-manager-flag";
  /** whether their login can actually press Approve (approveCut needs ADMIN) */
  canApprove: boolean;
};

/**
 * WHOSE VERDICT IT IS. Three answers, and the difference is reported rather
 * than smoothed over:
 *
 *   designated            Settings → Review Room names them. The real answer.
 *   creative-manager-flag TeamMember.creativeManager, which exists for the
 *                         shoot-bonus basis and may never have been set with
 *                         approvals in mind — so the caller is told.
 *   null                  nobody, and the board says "the office".
 *
 * `canApprove` is the on-call picker's `reachable` idea applied here: naming
 * somebody whose login cannot press the button is a rota that pages nobody.
 */
export async function creativeApprover(): Promise<CreativeApprover | null> {
  const { reviewRoomRules } = await import("@/lib/settings");
  const rules = await reviewRoomRules().catch(() => null);
  const picked = rules?.creativeApproverTeamMemberId
    ? await prisma.teamMember
        .findFirst({ where: { id: rules.creativeApproverTeamMemberId, active: true }, select: { id: true, name: true } })
        .catch(() => null)
    : null;
  const row =
    picked ??
    (await prisma.teamMember
      .findFirst({ where: { creativeManager: true, active: true }, select: { id: true, name: true } })
      .catch(() => null));
  if (!row) return null;
  const login = await prisma.appUser
    .findFirst({ where: { teamMemberId: row.id, role: { in: ["OWNER", "ADMIN"] }, status: "ACTIVE" }, select: { id: true } })
    .catch(() => null);
  return { id: row.id, name: row.name, from: picked ? "designated" : "creative-manager-flag", canApprove: !!login };
}

export async function opsExceptions(opts: { now?: Date } = {}): Promise<OpsException[]> {
  const now = (opts.now ?? new Date()).getTime();
  const cap = EXCEPTION_RULES.perKind;
  const approver = await creativeApprover();
  // SAY WHERE THE NAME CAME FROM. A name lifted off a flag that exists for the
  // shoot bonus is a guess wearing a person's face; naming somebody whose login
  // cannot press Approve is worse than naming nobody. Both are said out loud
  // rather than presented as an assignment.
  const verdictOwner = !approver
    ? "The office — nobody is named as creative approver"
    : !approver.canApprove
      ? `${approver.name} — but their login can't approve yet`
      : approver.from === "designated"
        ? approver.name
        : `${approver.name} (from the creative-manager flag — name one in Settings)`;

  const [unassigned, agingReviews, followUps, stalled, unsent] = await Promise.all([
    // 1. NOBODY ASSIGNED. A job in the editing lane whose editor is neither a
    // person nor the outside shop. The routing rules usually fill this in; a
    // row that reaches here is one they could not.
    prisma.project.findMany({
      where: {
        status: { in: ["SHOT", "EDITING", "REVISION"] },
        editorId: null,
        editorVendorKey: null,
        deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, waivedAt: null } },
      },
      select: { id: true, title: true, status: true, shootDate: true, deliveryDue: true, updatedAt: true },
      orderBy: { deliveryDue: "asc" },
      take: cap,
    }),
    // 2. WAITING ON A VERDICT. Uploaded, nobody has ruled, and the clock has
    // been running. The editor is finished; this one is the office's.
    prisma.reviewSubmission.findMany({
      where: { status: "PENDING", createdAt: { lt: new Date(now - EXCEPTION_RULES.reviewAgingDays * DAY) } },
      select: { id: true, projectId: true, round: true, createdAt: true, fileName: true, project: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
      take: cap,
    }),
    // 3. A CHASE DATE THAT PASSED. SmartTask.followUpAt is the date somebody
    // set for coming back to it; a date in the past with the task still open is
    // a promise to oneself that was not kept.
    prisma.smartTask.findMany({
      where: { followUpAt: { lt: new Date(now) }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true, title: true, followUpAt: true, blockedReason: true, projectId: true, owner: { select: { name: true } } },
      orderBy: { followUpAt: "asc" },
      take: cap,
    }),
    // 4. STUCK AT THE PROVIDER. A render holding a commitment with no movement.
    // `saving` is included: that is our own Dropbox copy, and a stuck one still
    // means a finished video nobody can send.
    prisma.topazJob.findMany({
      where: {
        state: { in: ["queued", "estimated", "uploading", "processing", "saving"] },
        updatedAt: { lt: new Date(now - EXCEPTION_RULES.renderStalledHours * 3_600_000) },
      },
      select: { id: true, projectId: true, state: true, error: true, updatedAt: true, project: { select: { title: true } } },
      orderBy: { updatedAt: "asc" },
      take: cap,
    }),
    // 5. AN APPROVED REPLACEMENT NOBODY SENT. Approved, not sent, and an EARLIER
    // round on the same cut did go out — so the client is holding a version we
    // have already replaced. This is the R03 shape, on a card rather than
    // waiting to be noticed.
    prisma.reviewSubmission.findMany({
      where: {
        status: "APPROVED",
        sentToClientAt: null,
        decidedAt: { lt: new Date(now - EXCEPTION_RULES.unsentDays * DAY) },
      },
      select: {
        id: true, projectId: true, round: true, decidedAt: true, deliverableId: true, slot: true,
        project: { select: { title: true } },
      },
      orderBy: { decidedAt: "asc" },
      take: cap * 3, // filtered below against the earlier-send test
    }),
  ]);

  const out: OpsException[] = [];

  for (const p of unassigned) {
    out.push({
      id: `unassigned:${p.id}`,
      kind: "unassigned",
      severity: p.deliveryDue && p.deliveryDue.getTime() < now ? "high" : "medium",
      title: streetOf(p.title),
      why: p.deliveryDue && p.deliveryDue.getTime() < now
        ? `Ready for editing, past its date, and no editor on it`
        : `Ready for editing with no editor on it`,
      owner: "Nobody yet",
      nextAction: "Pick an editor on the row in the Editing Room",
      href: `/edit/${p.id}`,
      ageDays: ageOf(p.shootDate ?? p.updatedAt, now),
    });
  }

  for (const r of agingReviews) {
    out.push({
      id: `review:${r.id}`,
      kind: "aging-review",
      severity: ageOf(r.createdAt, now) >= EXCEPTION_RULES.reviewAgingDays * 2 ? "high" : "medium",
      title: streetOf(r.project?.title),
      why: `Version ${r.round} has been waiting ${ageOf(r.createdAt, now)} days for a verdict`,
      owner: verdictOwner,
      nextAction: "Watch it and approve or send it back in the Review Room",
      href: `/edit/${r.projectId}`,
      ageDays: ageOf(r.createdAt, now),
    });
  }

  for (const t of followUps) {
    out.push({
      id: `followup:${t.id}`,
      kind: "overdue-followup",
      severity: ageOf(t.followUpAt, now) >= 3 ? "high" : "medium",
      title: t.title.slice(0, 90),
      why: t.blockedReason
        ? `Follow-up was due ${ageOf(t.followUpAt, now)} days ago — blocked: ${t.blockedReason}`
        : `Follow-up was due ${ageOf(t.followUpAt, now)} days ago`,
      owner: t.owner?.name ?? "Nobody yet",
      nextAction: t.blockedReason ? "Clear the blocker or move the date" : "Do it, or set a new date",
      href: t.projectId ? `/projects/${t.projectId}` : "/tasks",
      ageDays: ageOf(t.followUpAt, now),
    });
  }

  for (const j of stalled) {
    const hours = Math.floor((now - j.updatedAt.getTime()) / 3_600_000);
    out.push({
      id: `render:${j.id}`,
      kind: "stalled-render",
      severity: hours >= 24 ? "high" : "medium",
      title: streetOf(j.project?.title),
      why: j.error
        ? `The 1080p pass has not moved in ${hours}h — ${j.error.slice(0, 90)}`
        : `The 1080p pass has been "${j.state}" for ${hours}h`,
      owner: "Kyle",
      nextAction: "Try the pass again on the Ready-to-send row, or send the editor's export",
      href: `/edit/${j.projectId}`,
      ageDays: Math.floor(hours / 24),
    });
  }

  // The earlier-send test, in one query rather than one per row.
  const replacementKeys = unsent.filter((s) => s.deliverableId != null);
  if (replacementKeys.length) {
    const sentBefore = await prisma.reviewSubmission.findMany({
      where: {
        projectId: { in: [...new Set(replacementKeys.map((s) => s.projectId))] },
        sentToClientAt: { not: null },
      },
      select: { projectId: true, deliverableId: true, slot: true, round: true },
    });
    const sentKey = new Set(sentBefore.map((s) => `${s.projectId}|${s.deliverableId ?? "-"}|${s.slot ?? 0}`));
    let n = 0;
    for (const s of replacementKeys) {
      if (n >= cap) break;
      const key = `${s.projectId}|${s.deliverableId ?? "-"}|${s.slot ?? 0}`;
      const prior = sentBefore.find((p) => `${p.projectId}|${p.deliverableId ?? "-"}|${p.slot ?? 0}` === key && (p.round ?? 0) < s.round);
      if (!sentKey.has(key) || !prior) continue;
      n++;
      out.push({
        id: `unsent:${s.id}`,
        kind: "unsent-replacement",
        severity: "high",
        title: streetOf(s.project?.title),
        why: `Version ${s.round} was approved ${ageOf(s.decidedAt, now)} days ago and the client still has version ${prior.round}`,
        owner: "Kyle",
        nextAction: "Send it and press Mark as sent",
        href: `/edit/${s.projectId}`,
        ageDays: ageOf(s.decidedAt, now),
      });
    }
  }

  // High first, then oldest. A list somebody reads top to bottom.
  return out.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
    return b.ageDays - a.ageDays;
  });
}
