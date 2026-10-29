"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, MapPin, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalResolveAddress, portalSuggestAddresses } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { AddressParts, AddressSuggestion } from "@/lib/travel";

// ---------------------------------------------------------------------------
// THE FILMING ADDRESS, FOUND AS YOU TYPE (Oct 29 2026, Jordan: "Can we have an
// auto address detection and a way to add it manually as well?"). Joe Sutow's
// new build was on Google and on no free map, so his portal offered no times.
// Typing here suggests real addresses (Google Maps when its key answers, else
// OpenStreetMap); a pick fills the five fields below it, which stay open to
// type or correct by hand. Nothing is saved from here: "Save and see times"
// still looks the address up on the server.
// ---------------------------------------------------------------------------

const newSession = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

export function AddressLookup({ onPick, className }: { onPick: (parts: AddressParts) => void; className?: string }) {
  const listId = useId();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const session = useRef<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 4) { setItems([]); setOpen(false); return; }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      session.current ??= newSession();
      setBusy(true);
      const got = await portalSuggestAddresses(portalAuthFromLocation(), text, session.current).catch(() => []);
      if (mine !== seq.current) return;
      setBusy(false);
      setItems(got);
      setActive(got.length ? 0 : -1);
      setOpen(true);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const pick = async (s: AddressSuggestion) => {
    setOpen(false);
    setNote(null);
    let parts = s.parts;
    if (!parts) {
      setBusy(true);
      parts = await portalResolveAddress(portalAuthFromLocation(), s.id, session.current ?? newSession()).catch(() => null);
      setBusy(false);
    }
    session.current = null;
    if (!parts) { setNote("That one couldn't be filled in. Type the address in the boxes below."); return; }
    setQ(s.label);
    onPick(parts);
    setNote("Filled in below. Check it, add a unit if there is one, then save.");
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i <= 0 ? items.length - 1 : i - 1)); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); void pick(items[active]); }
    else if (e.key === "Escape") setOpen(false);
  };

  const google = items.some((s) => s.id.startsWith("g:"));
  return (
    <div className={cn("relative", className)}>
      <label className="relative block">
        <span className="sr-only">Find the filming address</span>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          placeholder="Start typing the address"
          value={q}
          onChange={(e) => { setQ(e.target.value); setNote(null); }}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onFocus={() => items.length && setOpen(true)}
          className="min-h-11 w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-9 text-base outline-none focus:border-brand sm:text-sm"
        />
        {busy && <Loader2 aria-hidden className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted" />}
      </label>
      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          <ul id={listId} role="listbox" aria-label="Addresses" className="max-h-64 overflow-y-auto py-1">
            {items.length === 0 && <li className="px-3 py-2.5 text-sm text-muted">No match. Type it in the boxes below.</li>}
            {items.map((s, i) => (
              <li
                key={s.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); void pick(s); }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm", i === active && "bg-surface-2")}
              >
                <MapPin aria-hidden className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 break-words">{s.label}</span>
              </li>
            ))}
          </ul>
          {items.length > 0 && <p className="border-t border-border px-3 py-1 text-right text-[11px] text-muted">{google ? "Google Maps" : "© OpenStreetMap contributors"}</p>}
        </div>
      )}
      {note && <p role="status" className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}
