"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AtSign } from "lucide-react";
import { listMentionablePeople, type MentionPerson } from "@/app/mentions/actions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// Shared @mention composer for note comments — a controlled textarea that pops
// a teammate picker when you type "@" (same UX as the project team thread).
// Picking inserts "@Full Name "; the server actions parse the names and notify
// the tagged people. The roster self-fetches ONCE per session (module cache),
// so callers don't have to thread people-props through six surfaces. The
// picker renders through a PORTAL with fixed positioning — the note surfaces
// live inside overflow-hidden panels (lightbox stage, thread bottom sheet,
// Section cards) that would otherwise clip it.

let rosterCache: MentionPerson[] | null = null;
let rosterPromise: Promise<MentionPerson[]> | null = null;
function loadRoster(): Promise<MentionPerson[]> {
  if (rosterCache) return Promise.resolve(rosterCache);
  if (!rosterPromise) {
    rosterPromise = listMentionablePeople()
      .then((people) => {
        rosterCache = people;
        return people;
      })
      .catch(() => {
        rosterPromise = null; // allow a retry next mount
        return [];
      });
  }
  return rosterPromise;
}

const AT_FRAGMENT = /@([\p{L}\d]*)$/u;

export function MentionTextarea({
  value,
  onChange,
  placeholder,
  rows = 2,
  className,
  autoFocus,
  onEnter,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 1 renders a single-line feel (still a textarea so the picker anchors). */
  rows?: number;
  className?: string;
  autoFocus?: boolean;
  /** Called on plain Enter when the mention picker is closed (single-line composers). */
  onEnter?: () => void;
  disabled?: boolean;
}) {
  const [people, setPeople] = useState<MentionPerson[]>(rosterCache ?? []);
  const [query, setQuery] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    void loadRoster().then((p) => {
      if (alive) setPeople(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const suggestions =
    query === null ? [] : people.filter((m) => m.name.toLowerCase().includes(query)).slice(0, 6);

  // Re-derive the @fragment from the LIVE caret — runs on typing AND on caret
  // moves (arrows/clicks fire onSelect), so the picker never acts on a stale
  // position and never swallows an Enter meant for the send button.
  function syncQuery(ta: HTMLTextAreaElement) {
    const caret = ta.selectionStart ?? ta.value.length;
    const m = ta.value.slice(0, caret).match(AT_FRAGMENT);
    setQuery(m ? m[1].toLowerCase() : null);
    setAnchor(ta.getBoundingClientRect());
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    syncQuery(e.target);
  }

  function pick(member: MentionPerson) {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? value.length;
    const head = value.slice(0, caret);
    if (!AT_FRAGMENT.test(head)) {
      setQuery(null); // caret drifted off the fragment — just close, change nothing
      return;
    }
    const before = head.replace(AT_FRAGMENT, `@${member.name} `);
    const next = before + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(before.length, before.length);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length > 0) {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[0]);
        return;
      }
      if (e.key === "Escape") {
        setQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && onEnter) {
      e.preventDefault();
      onEnter();
    }
  }

  // Fixed-position picker near the field: below when there's room, else above.
  const dropdown =
    suggestions.length > 0 && anchor && typeof document !== "undefined"
      ? createPortal(
          <div
            style={
              window.innerHeight - anchor.bottom >= 200
                ? { position: "fixed", left: anchor.left, top: anchor.bottom + 4 }
                : { position: "fixed", left: anchor.left, bottom: window.innerHeight - anchor.top + 4 }
            }
            className="z-[1600] max-h-44 w-56 overflow-y-auto rounded-xl border border-border bg-surface shadow-2xl"
          >
            {suggestions.map((m) => (
              <button
                key={m.id}
                type="button"
                // mousedown (not click) so the textarea blur doesn't kill it first
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
              >
                <AtSign className="size-3.5 shrink-0 text-brand" />
                <span className="truncate">{m.name}</span>
              </button>
            ))}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="relative min-w-0 flex-1">
      <AutoTextarea
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        onSelect={(e) => syncQuery(e.currentTarget)}
        onBlur={() => setTimeout(() => setQuery(null), 150)} // let a click on a suggestion land first
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        className={className ?? "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"}
      />
      {dropdown}
    </div>
  );
}
