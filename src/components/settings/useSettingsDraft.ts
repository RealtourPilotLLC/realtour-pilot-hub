"use client";

import { useEffect, useRef, useState, useTransition, type SetStateAction } from "react";
import { attemptSettingsSave, finishSettingsSave, settingsDraftDirty, type SettingsDraft, type SettingsSaveResult } from "@/lib/settingsDraft";

/** A section keeps its input through errors and acknowledges the exact save. */
export function useSettingsDraft<T>(initial: T) {
  const [state, setState] = useState<SettingsDraft<T>>({ value: initial, saved: initial, feedback: null });
  const [busy, start] = useTransition();
  const saving = useRef(false);
  const dirty = settingsDraftDirty(state);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return {
    value: state.value, dirty, busy, feedback: state.feedback,
    setValue: (next: SetStateAction<T>) => setState((previous) => ({
      ...previous,
      value: typeof next === "function" ? (next as (value: T) => T)(previous.value) : next,
      feedback: null,
    })),
    save: (action: (value: T) => Promise<SettingsSaveResult>) => {
      if (saving.current) return;
      saving.current = true;
      const submitted = state.value;
      start(async () => {
        try {
          const result = await attemptSettingsSave(submitted, action);
          setState((current) => finishSettingsSave(current, submitted, result));
        } finally { saving.current = false; }
      });
    },
  };
}
