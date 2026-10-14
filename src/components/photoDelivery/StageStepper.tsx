import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Where the job is in the pipeline (plan 3.3), as a stepper. Side states sit
// on the step they belong to: a hold on the stage it left, a failed edit on
// Editing, a delivery mismatch on Delivering, a client revision on Fixing.
// ---------------------------------------------------------------------------

const STEPS: { key: string; label: string }[] = [
  { key: "EDITING", label: "Editing" },
  { key: "EDITED", label: "Landed" },
  { key: "QC_RUNNING", label: "QC" },
  { key: "QC_REVIEW", label: "Decision" },
  { key: "FIXING", label: "Fixing" },
  { key: "READY", label: "Ready" },
  { key: "DELIVERING", label: "Delivering" },
  { key: "DELIVERED", label: "Delivered" },
];

export function StageStepper({ stage, holdResumeStage }: { stage: string; holdResumeStage: string | null }) {
  const side: Record<string, { at: string; label: string; bad: boolean }> = {
    ON_HOLD: { at: holdResumeStage && STEPS.some((s) => s.key === holdResumeStage) ? holdResumeStage : "QC_REVIEW", label: "On hold", bad: true },
    EDIT_FAILED: { at: "EDITING", label: "Edit failed", bad: true },
    DELIVERY_MISMATCH: { at: "DELIVERING", label: "Mismatch", bad: true },
    REVISION_REQUESTED: { at: "FIXING", label: "Revision", bad: false },
  };
  const s = side[stage];
  const at = s ? s.at : stage;
  const idx = Math.max(0, STEPS.findIndex((x) => x.key === at));
  return (
    <ol className="flex w-full items-center gap-1 overflow-x-auto pb-1" aria-label="Pipeline stage">
      {STEPS.map((step, i) => {
        const done = i < idx || (stage === "DELIVERED" && i === idx);
        const current = i === idx && stage !== "DELIVERED";
        const label = current && s ? s.label : step.label;
        return (
          <li key={step.key} className="flex min-w-0 shrink-0 items-center gap-1" aria-current={current ? "step" : undefined}>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ring-1 ring-inset",
                done && "bg-success-soft text-success ring-success/30",
                current && !s?.bad && "bg-brand text-white ring-brand",
                current && s?.bad && "bg-danger-action text-white ring-danger",
                !done && !current && "bg-surface-2 text-muted ring-border",
              )}
            >
              {done ? <Check aria-hidden className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("whitespace-nowrap text-[12px]", current ? "font-semibold text-foreground" : "text-muted")}>
              {label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
            {i < STEPS.length - 1 && <span aria-hidden className={cn("mx-1 h-px w-4 shrink-0 sm:w-6", i < idx ? "bg-success/50" : "bg-border-strong")} />}
          </li>
        );
      })}
    </ol>
  );
}
