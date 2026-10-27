import { Lightbulb, Sparkles } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { NotesCard } from "@/components/content/Workspace";
import type { KnowledgeViewData, KeptItem } from "@/lib/knowledgeCurator";
import type { KeptPlace } from "@/lib/knowledgeCuratorCore";

// ---------------------------------------------------------------------------
// WHAT THE AI KEPT (Oct 27 2026). Jordan: "I don't want to have to come in
// here and review everybody's information for their calls. AI should handle
// it. And if it can't figure it out, then get rid of it."
//
// Plan › Knowledge used to be a review pile (FactsPanel: accept, reject, mark
// confidential, one fact at a time). The knowledge curator now sorts every
// fact into the place it is used (knowledgeCurator.ts), so this view only
// shows the result, grouped by where each line goes. Nothing to press. What
// the AI dropped, and why, sits under Details with the legacy notes.
// ---------------------------------------------------------------------------

const PLACES: { key: KeptPlace; title: string; hint: string }[] = [
  { key: "identity", title: "Creative identity", hint: "style inspirations, humour, what they will and won't do on camera" },
  { key: "strategy", title: "Content strategy", hint: "one line each, beside the strategy" },
  { key: "editing", title: "For the editor", hint: "technical edit preferences, on the editor's brief" },
  { key: "filming", title: "For the shoot", hint: "filming-day preferences" },
  { key: "cast", title: "Skit cast", hint: "also on Settings › Skit cast" },
  { key: "script", title: "About them, for scripts", hint: "what the script writer may use" },
  { key: "team", title: "For the team only", hint: "never in a video" },
  { key: "oneoff", title: "Until the next call", hint: "dated; used to recognise the call, then it expires" },
];

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;

function statusLine(d: KnowledgeViewData): string {
  const last = day(d.lastRunAt);
  if (d.waiting > 0) return `${d.waiting} new ${d.waiting === 1 ? "note" : "notes"} from their calls, sorted on the AI's next pass${last ? ` (last pass ${last})` : ""}.`;
  if (last) return `Everything from their calls is sorted. Last pass ${last}.`;
  return "The AI sorts what their calls leave here, on its own.";
}

function Row({ f }: { f: KeptItem }) {
  return (
    <li className="px-5 py-2 text-[13px]">
      <p>{f.body}</p>
      {(f.reason || f.when || f.by === "person") && (
        <p className="mt-0.5 text-[11px] text-muted-2">
          {[f.when, f.by === "person" ? "kept by the team" : null, f.by === "ai" ? f.reason : null].filter(Boolean).join(" · ")}
        </p>
      )}
    </li>
  );
}

export function KnowledgeView({
  data, clientId, notes,
}: {
  data: KnowledgeViewData;
  clientId: string;
  notes: { id: string; body: string; authorName: string | null; intelligence: boolean; at: string }[];
}) {
  const groups = PLACES.map((p) => ({ ...p, items: data.kept.filter((k) => k.place === p.key) })).filter((g) => g.items.length > 0);
  return (
    <div data-knowledge-view className="space-y-4">
      <Section icon={Sparkles} title="What the AI kept" flush>
        <p className="border-b px-5 py-2.5 text-[12px] text-muted">{statusLine(data)}</p>
        {groups.length === 0 ? (
          <p className="px-5 py-3 text-[13px] text-muted-2">Nothing kept yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {groups.map((g) => (
              <div key={g.key} data-kept-place={g.key}>
                <div className="flex flex-wrap items-baseline gap-x-2 px-5 pb-1 pt-3">
                  <h3 className="text-[13px] font-semibold">{g.title}</h3>
                  <span className="text-[11px] text-muted-2">{g.hint}</span>
                </div>
                <ul className="pb-1.5">
                  {g.items.map((f) => <Row key={f.id} f={f} />)}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <details className="group rounded-2xl border bg-surface">
        <summary className="flex min-h-11 cursor-pointer items-center px-5 text-[13px] font-medium text-muted">Details</summary>
        <div className="space-y-4 border-t px-5 py-4">
          <div>
            <h3 className="text-[13px] font-semibold">Dropped by the AI</h3>
            <p className="text-[11px] text-muted-2">
              Not kept: unclear, not useful, or past its date.{data.merged > 0 ? ` ${data.merged} more were merged into the lines above.` : ""}
            </p>
            {data.dropped.length === 0 ? (
              <p className="mt-1.5 text-[12px] text-muted-2">Nothing dropped.</p>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {data.dropped.slice(0, 40).map((f) => (
                  <li key={f.id} data-dropped-fact={f.id} className="text-[12px]">
                    <span className="text-muted">{f.body}</span>
                    {(f.reason || f.when) && <span className="text-muted-2">{` (${[f.when, f.reason].filter(Boolean).join(", ")})`}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="max-w-2xl">
            <p className="mb-2 text-[12px] text-muted-2">Program notes, still read by the AI.</p>
            <NotesCard clientId={clientId} notes={notes} />
          </div>
        </div>
      </details>
    </div>
  );
}

/**
 * Plan › Strategy: the one-line notes the curator kept from the calls
 * (strategy_note.*), e.g. "Ideal price point $600k to $800k; takes $1M+ homes
 * when they come up." Read-only, beside the strategy (never written into the
 * client's strategy document). Nothing renders when there are none.
 */
export function StrategyNotesCard({ notes }: { notes: { id: string; key: string; line: string; when: string | null }[] }) {
  if (!notes.length) return null;
  return (
    <Section icon={Lightbulb} title="From their calls" flush>
      <ul data-strategy-notes className="divide-y divide-border">
        {notes.map((n) => (
          <li key={n.id} className="px-5 py-2 text-[13px]">
            <p>{n.line}</p>
            {n.when && <p className="mt-0.5 text-[11px] text-muted-2">{n.when}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
