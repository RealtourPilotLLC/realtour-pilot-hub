"use client";

import { useEffect, useRef, useState } from "react";

type Operation = "login" | "invite" | "role" | "revoke" | "cancelHeld" | "rotate" | "expire" | "mint";
type Marker = { attemptId: string; operation: Operation };
const operations: Operation[] = ["login", "invite", "role", "revoke", "cancelHeld", "rotate", "expire", "mint"];
function read(key: string): Marker | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const marker = JSON.parse(raw) as Marker;
  if (!/^[0-9a-f-]{36}$/i.test(marker.attemptId) || !operations.includes(marker.operation)) throw new Error("Invalid retry marker");
  return marker;
}

/** Current-tab retry guard only: a marker does not prove a server operation
 * completed. It contains no address, name, password, portal token or link. */
export function useAccessAttempt(key: string | (() => string)) {
  const currentKey = () => typeof key === "function" ? key() : key;
  const busy = useRef(false);
  const active = useRef<{ attemptId: string; key: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [held, setHeld] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped || busy.current) return;
      try { if (read(typeof key === "function" ? key() : key)) setHeld(true); }
      catch { setHeld(true); }
    });
    return () => { stopped = true; };
  }, [key]);

  function begin(operation: Operation): string | null {
    if (busy.current || held) return null;
    let attemptId: string;
    try {
      const storageKey = currentKey();
      if (read(storageKey)) { setHeld(true); return null; }
      attemptId = crypto.randomUUID();
      sessionStorage.setItem(storageKey, JSON.stringify({ attemptId, operation } satisfies Marker));
      active.current = { attemptId, key: storageKey };
    } catch {
      setLocalError("This request could not be prepared on this device. No request was started. Keep your input and try again when browser storage is available.");
      return null;
    }
    busy.current = true; setPending(true); setLocalError(null);
    return attemptId;
  }
  function finish(attemptId: string, known: boolean) {
    busy.current = false; setPending(false);
    if (!known) { setHeld(true); return; }
    try {
      const storageKey = active.current?.attemptId === attemptId ? active.current.key : currentKey(), marker = read(storageKey);
      if (marker?.attemptId === attemptId) sessionStorage.removeItem(storageKey);
      else if (marker) { setHeld(true); return; }
      setHeld(false);
    } catch { setHeld(true); }
  }
  return { begin, finish, pending, held, localError, blocked: pending || held };
}
