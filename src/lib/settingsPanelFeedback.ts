export type PanelActionResult = { ok: boolean; message: string };
export type PanelRead<T> = { ok: true; data: T } | { ok: false; message: string };
export type PanelChoice<T> = { value: T | null; saved: T | null };

/** A refresh follows the stored choice only while the user has not changed it. */
export function refreshPanelChoice<T>(current: PanelChoice<T>, loaded: T): PanelChoice<T> {
  return { value: current.value === null || current.value === current.saved ? loaded : current.value, saved: loaded };
}

/** Network failures do not establish whether a server action changed anything. */
export async function attemptPanelOperation<T extends PanelActionResult>(operation: () => Promise<T>, failure: T): Promise<T> {
  try { return await operation(); }
  catch { return failure; }
}

export async function readSettingsPanel<T extends object>(read: () => Promise<T | { error: string }>): Promise<PanelRead<T>> {
  try {
    const result = await read();
    if ("error" in result) return { ok: false, message: String(result.error) };
    return { ok: true, data: result };
  } catch { return { ok: false, message: "The current settings could not be read. Try Refresh again." }; }
}

/** A confirmed change remains confirmed even if its separate read-back fails.
 * Never retry a mutation to repair a read failure. */
export async function changeSettingsPanel<T extends object>(action: () => Promise<PanelActionResult>, read: () => Promise<T | { error: string }>) {
  let result: PanelActionResult;
  let requiresRefresh = false;
  try { result = await action(); }
  catch {
    requiresRefresh = true;
    result = { ok: false, message: "The change could not be confirmed. Refresh the current settings before trying again." };
  }
  return { result, read: result.ok ? await readSettingsPanel(read) : null, requiresRefresh };
}
