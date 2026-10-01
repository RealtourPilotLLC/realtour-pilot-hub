import type { Verdict } from "@/lib/reviewAttribution";

/** Stage of this exact round. Approval here is creative QC, not delivery. */
export function reviewStage(cut: { status: string; heldForCheck?: boolean; verdict?: Verdict | null }) {
  switch (cut.status) {
    case "APPROVED": return { label: cut.verdict?.source === "delivered" ? "Approval recorded at delivery" : "Approved in creative review", tone: "success" as const };
    case "SUPERSEDED": return { label: "Earlier version — replaced by a newer cut", tone: "muted" as const };
    case "WITHDRAWN": return { label: "Withdrawn — waiting on the next version", tone: "muted" as const };
    case "UPLOADING": return { label: "Upload in progress — not in review yet", tone: "muted" as const };
    case "UPLOAD_FAILED": return { label: "Upload incomplete — not in review", tone: "warning" as const };
    case "PENDING": return cut.heldForCheck
      ? { label: "Waiting on the editor’s check", tone: "muted" as const }
      : { label: "Awaiting creative review", tone: "warning" as const };
    case "CHANGES_REQUESTED": return {
      label: cut.verdict?.source === "client" ? "Client changes requested" : cut.verdict?.source === "office" ? "Creative review changes requested" : "Changes requested — source not recorded",
      tone: "warning" as const,
    };
    default: return { label: "Review state not recognized — reload to check", tone: "muted" as const };
  }
}

/** Send only fixes actually displayed and left checked by this reviewer. */
export function verifiedFixIds(fixes: { id: string }[], notFixed: ReadonlySet<string>): string[] {
  return [...new Set(fixes.filter((fix) => !notFixed.has(fix.id)).map((fix) => fix.id))];
}
