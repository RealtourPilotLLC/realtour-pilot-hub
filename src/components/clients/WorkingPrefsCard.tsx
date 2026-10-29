import { ListChecks } from "lucide-react";
import { linkify } from "@/components/ui/Markdown";
import { etDateTime } from "@/lib/datetime";
import { PREF_GROUPS, editingByTopic, type SortedPrefs } from "@/lib/workingPrefsCore";

// ---------------------------------------------------------------------------
// WORKING PREFERENCES, ORGANIZED (Jordan, Oct 29 2026: "Working preferences
// should be summarized and organized and shown in full"). Everything the
// client's notes, Brand Profile, calls and working profile say about how to
// work with them, merged and sorted by lib/workingPrefs into editing (by
// topic), shooting, communication and other, every line whole. The editor
// brief shows the editing group only. Read-only: the notes themselves are
// edited where they live (the customer note, Client preferences, their Brand
// Profile).
// ---------------------------------------------------------------------------

export function WorkingPrefsCard({ prefs, state }: { prefs: SortedPrefs | null; state: "none" | "ready" | "stale" }) {
  if (state === "none") return null;
  const groups = prefs
    ? PREF_GROUPS.map((g) => ({
        ...g,
        topics: g.key === "editing" ? editingByTopic(prefs) : [{ topic: null, lines: prefs[g.key].map((p) => p.text) }].filter((t) => t.lines.length),
      })).filter((g) => g.topics.length)
    : [];
  return (
    <section aria-labelledby="working-prefs-title" data-working-prefs={state} className="panel-shadow min-w-0 rounded-2xl border border-border bg-surface px-4 py-4">
      <h2 id="working-prefs-title" className="flex items-center gap-2 text-base font-semibold"><ListChecks aria-hidden className="size-4 text-brand" />Working preferences</h2>
      <p className="mt-0.5 text-xs text-muted">
        Sorted from their notes, Brand Profile, calls and working profile. Editors see the editing ones on every brief.
        {state === "stale" && " Updating with the latest notes; reload in a minute."}
      </p>
      {!prefs ? (
        <p className="mt-3 text-sm text-muted">Sorting their preferences now. Reload in a minute.</p>
      ) : groups.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nothing on file reads as a standing preference yet.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map((g) => (
            <div key={g.key} data-pref-group={g.key}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{g.label}</h3>
              {g.topics.map((t) => (
                <div key={t.topic ?? g.key} className="mt-1.5">
                  {t.topic && <p className="text-xs font-medium text-foreground/80">{t.topic}</p>}
                  <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-sm leading-relaxed text-foreground/90">
                    {t.lines.map((line, i) => <li key={i} className="whitespace-pre-wrap break-words">{linkify(line)}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          ))}
          <p className="text-[11px] text-muted-2">Sorted {etDateTime(prefs.at)} ET</p>
        </div>
      )}
    </section>
  );
}
