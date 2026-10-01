export type SettingsSaveResult = { ok: boolean; message: string };
export type SettingsDraft<T> = {
  value: T;
  saved: T;
  feedback: SettingsSaveResult | null;
};

export function settingsDraftDirty<T>(state: SettingsDraft<T>): boolean {
  return JSON.stringify(state.value) !== JSON.stringify(state.saved);
}

/** Only the submitted snapshot is acknowledged; later input remains unsaved. */
export function finishSettingsSave<T>(state: SettingsDraft<T>, submitted: T, result: SettingsSaveResult): SettingsDraft<T> {
  return { ...state, saved: result.ok ? submitted : state.saved, feedback: result };
}

export async function attemptSettingsSave<T>(submitted: T, action: (value: T) => Promise<SettingsSaveResult>): Promise<SettingsSaveResult> {
  try { return await action(submitted); }
  catch { return { ok: false, message: "The save could not be confirmed. Your edits are still here; try Save again." }; }
}
