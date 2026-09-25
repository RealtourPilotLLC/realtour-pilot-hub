import { ImportPanel } from "@/components/content/ImportPanel";
import { loadImportTab } from "../programData";
import type { TabCtx } from "./shared";

// IMPORT (UI-02) — a tool, not a primary tab: reached from the header's Tools
// menu. Preview first, per-client month confirmation, nothing approved by an
// import — unchanged.
export async function ImportTab({ ctx }: { ctx: TabCtx }) {
  const d = await loadImportTab(ctx.id);
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight">Import history</h2>
      <ImportPanel enrollmentId={ctx.id} batches={d.batches} reviewItems={d.reviewItems} pillars={d.pillars} isOwner={ctx.ownerEyes} migrationDone={d.migrationDone} />
    </div>
  );
}
