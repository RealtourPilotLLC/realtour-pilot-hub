"use client";

import { useEffect, useRef, useState } from "react";

type Marker = { attemptId: string; operation: "save" | "find" | "sync" | "dm" };
function read(key: string): Marker | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as Marker;
  if (!/^[0-9a-f-]{36}$/i.test(value.attemptId) || !["save", "find", "sync", "dm"].includes(value.operation)) throw new Error("Invalid Slack retry marker");
  return value;
}

// This current-tab marker guards repeats across refresh. It is not evidence
// that a database write or Slack send ended. It stores no Slack ID or message.
export function useSlackAttempt(key: string) {
  const busy = useRef(false), active = useRef<{ attemptId: string; key: string } | null>(null);
  const [pending, setPending] = useState(false), [held, setHeld] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped || busy.current) return;
      try { if (read(key)) setHeld(true); } catch { setHeld(true); }
    });
    return () => { stopped = true; };
  }, [key]);
  function begin(operation: Marker["operation"]) {
    if (busy.current || held) return null;
    let id: string;
    try {
      if (read(key)) { setHeld(true); return null; }
      id = crypto.randomUUID();
      sessionStorage.setItem(key, JSON.stringify({ attemptId: id, operation } satisfies Marker));
      active.current = { attemptId: id, key };
    } catch {
      setLocalError("This request could not be prepared on this device. No request was started. Keep your input and try again when browser storage is available.");
      return null;
    }
    busy.current = true; setPending(true); setLocalError(null);
    return id;
  }
  function finish(id: string, known: boolean) {
    busy.current = false; setPending(false);
    if (!known) { setHeld(true); return; }
    try {
      const storageKey = active.current?.attemptId === id ? active.current.key : key, marker = read(storageKey);
      if (marker?.attemptId === id) sessionStorage.removeItem(storageKey);
      else if (marker) { setHeld(true); return; }
      setHeld(false);
    } catch { setHeld(true); }
  }
  return { begin, finish, pending, held, localError, blocked: pending || held };
}
