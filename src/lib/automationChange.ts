type Result = { ok: boolean; message: string };
export type AutomationChangeResult = Result & { uncertain: boolean; needsReload: boolean };

/** UI receipt only. Server actions retain all permission/rollout/backlog gates. */
export async function attemptAutomationChange(opts: {
  includeBacklog: boolean;
  setBacklog: () => Promise<Result>;
  setSwitch: () => Promise<Result>;
}): Promise<AutomationChangeResult> {
  let backlogSaved = false;
  let switchAttempted = false;
  try {
    if (opts.includeBacklog) {
      const backlog = await opts.setBacklog();
      if (!backlog.ok) return { ...backlog, uncertain: false, needsReload: false };
      backlogSaved = true;
    }
    switchAttempted = true;
    const result = await opts.setSwitch();
    const partial = backlogSaved && !result.ok;
    return { ...result, message: `${partial ? "The backlog choice was saved. " : ""}${result.message}${partial ? " Reload Settings to read the updated batch before trying again." : ""}`, uncertain: false, needsReload: partial };
  } catch {
    return { ok: false, uncertain: true, needsReload: true, message: switchAttempted
      ? `${backlogSaved ? "The backlog choice was saved. " : ""}The switch change could not be confirmed. Reload Settings to check the recorded switch and backlog before trying again.`
      : "The backlog choice could not be confirmed. The switch was not attempted. Reload Settings to check the recorded backlog before trying again." };
  }
}

export function transcriptBatchReadable(batch: object | null): boolean {
  return !!batch && !("error" in batch);
}
