import "server-only";
import { prisma } from "@/lib/prisma";
import { CAUSE_LABEL, hasConfirmedIssueCause, isEditorCaused, type IssueCause } from "@/lib/issueCauses";
import { isSyntheticClientRow } from "@/lib/testClients";

/** Read the existing issue ledger; optional QC checkboxes are never evidence here. */
export async function revisionQuality(days = 30, opts: { includeTest?: boolean; now?: Date } = {}) {
  const to = opts.now ?? new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const excluded = opts.includeTest === false
    ? (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id)
    : [];
  // Plain project references can outlive records. Unlinked history cannot be
  // assigned to a normal client and is reported separately, never as clean work.
  const rows = await prisma.revisionIssue.findMany({ where: { createdAt: { gte: from, lte: to } } });
  const projects = await prisma.project.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } }, select: { id: true, clientId: true } });
  const hidden = new Set(excluded);
  const known = new Set(projects.filter((p) => !hidden.has(p.clientId)).map((p) => p.id));
  const allProjectIds = new Set(projects.map((p) => p.id));
  const visible = rows.filter((r) => known.has(r.projectId));
  const applicable = visible.filter((r) => !r.duplicateOfId && r.state !== "DUPLICATE" && r.state !== "NOT_APPLICABLE");
  const confirmed = applicable.filter(hasConfirmedIssueCause);
  const versions = await prisma.reviewSubmission.findMany({
    where: { id: { in: [...new Set(confirmed.map((r) => r.raisedOnSubmissionId).filter((id): id is string => !!id))] } },
    select: { id: true, projectId: true },
  });
  const versionProject = new Map(versions.map((v) => [v.id, v.projectId]));
  const linkedVersion = (r: (typeof confirmed)[number]) => !!r.raisedOnSubmissionId && versionProject.get(r.raisedOnSubmissionId) === r.projectId;
  const counts = new Map<IssueCause, number>();
  for (const row of confirmed) counts.set(row.cause as IssueCause, (counts.get(row.cause as IssueCause) ?? 0) + 1);
  const attributed = confirmed.filter((r) => isEditorCaused(r.cause) && !!r.versionEditorKey?.trim());
  return {
    windowDays: days, fromISO: from.toISOString(), toISO: to.toISOString(), includeTest: opts.includeTest !== false,
    applicableIssues: applicable.length,
    confirmedIssues: confirmed.length,
    awaitingClassification: applicable.length - confirmed.length,
    notApplicable: visible.filter((r) => r.state === "NOT_APPLICABLE" && !r.duplicateOfId).length,
    duplicates: visible.filter((r) => r.state === "DUPLICATE" || !!r.duplicateOfId).length,
    unlinkedHistory: rows.filter((r) => !allProjectIds.has(r.projectId)).length,
    attributedEditorIssues: attributed.length,
    editorIssuesWithoutAttribution: confirmed.filter((r) => isEditorCaused(r.cause) && !r.versionEditorKey?.trim()).length,
    affectedVersions: new Set(confirmed.filter(linkedVersion).map((r) => r.raisedOnSubmissionId)).size,
    versionsNotRecorded: confirmed.filter((r) => !linkedVersion(r)).length,
    byCause: [...counts.entries()].map(([cause, count]) => ({ cause, label: CAUSE_LABEL[cause], count })),
  };
}

export type RevisionQuality = Awaited<ReturnType<typeof revisionQuality>>;
