import Link from "next/link";
import type { RevisionQuality } from "@/lib/revisionQuality";

export function RevisionQualitySummary({ report }: { report: RevisionQuality }) {
  return (
    <div className="space-y-3 text-sm">
      <p>
        <strong>{report.confirmedIssues} of {report.applicableIssues}</strong> applicable revision issues have a reviewer-confirmed cause
        {report.awaitingClassification > 0 ? ` · ${report.awaitingClassification} awaiting classification` : ""}.
      </p>
      <p className="text-muted">Last {report.windowDays} days, by issue creation date. {report.includeTest ? "Includes test records." : "Test records excluded."} Optional QC ticks do not contribute to these counts.</p>
      {report.byCause.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {report.byCause.map((row) => <li key={row.cause} className="flex justify-between gap-3"><span>{row.label}</span><strong className="tabular-nums">{row.count}</strong></li>)}
        </ul>
      ) : <p className="text-muted">No confirmed causes in this period. Unknown causes remain unknown.</p>}
      <p className="text-muted">
        {report.attributedEditorIssues} editor-caused issue{report.attributedEditorIssues === 1 ? "" : "s"} with a recorded editor key.
        {report.editorIssuesWithoutAttribution > 0 ? ` ${report.editorIssuesWithoutAttribution} more have no editor attribution and are excluded from individual results.` : ""}
        {` ${report.affectedVersions} distinct cut versions with confirmed causes; ${report.versionsNotRecorded} issues lack a matching version record.`}
      </p>
      <p className="text-muted">Excluded: {report.notApplicable} not applicable · {report.duplicates} duplicates. {report.unlinkedHistory > 0 ? `${report.unlinkedHistory} historical issues have no linked job and need reconciliation.` : ""} Imported history stays unknown until reviewed on its job record.</p>
      <Link href={report.includeTest ? "/quality?tab=editors&test=1" : "/quality?tab=editors"} className="inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4">Review causes and editor results</Link>
    </div>
  );
}
