"use client";

import type { WriterCardUi } from "@/lib/scriptWriter/record";

// ---------------------------------------------------------------------------
// WRITER'S NOTES (Oct 23 2026): the one small fold at the very bottom of the
// office script card, closed by default, plain grey. Staff only; nothing here
// reaches the portal.
//
// Jordan, Oct 23 2026: "For the scripting for the monthly content, I don't
// need to see that it needs fixes; I just need it to be fixed. This is way
// too much. I just want to come in and either make a quick edit or just
// approve and send." So the card shows the script and two actions; the
// review machinery (creative review results, craft scores, fix rounds, gaps,
// word counts, red warnings) is gone from it. What is worth keeping is here,
// in neutral words:
//
//   version    which version this is and how it was made (an automatic round
//              reads "polished by the AI after its own review", never its
//              review notes), the spoken length, approval and release dates
//   heads-up   the client edited an answer since this draft; the topic's
//              format changed since this version was written
//   why        the writer's angle (the old writer) or rationale (the new one:
//              the hook, the takeaway, how her strategy shaped it)
//   brief      the new writer's topic brief: the message, the viewer, what she
//              said, what is kept and left out, the hooks considered
//   sources    what her sources did not cover (the writer's open questions)
//
// Nothing in it says a script needs fixes, failed a check, or was flagged:
// the automatic check keeps the best version current on its own
// (scriptJudge.ts, "never a worse version").
// ---------------------------------------------------------------------------

const LIST = "mt-0.5 space-y-0.5 pl-3";
const ANGLE_LABELS: [string, string][] = [["viewer", "Viewer"], ["belief", "Belief"], ["stake", "Stake"], ["angle", "Angle"], ["clientTake", "Client's take"], ["payoff", "Payoff"]];

function Items({ label, xs }: { label: string; xs: { text: string; source?: string; reason?: string; sources?: string }[] }) {
  if (!xs.length) return null;
  return (
    <div className="mt-1">
      <p className="font-semibold">{label}</p>
      <ul className={LIST}>
        {xs.map((x, i) => (
          <li key={i}>
            {x.text}
            {x.source ? <span className="text-muted-2"> [{x.source}]</span> : null}
            {x.sources ? <span className="text-muted-2"> [{x.sources}]</span> : null}
            {x.reason ? <span className="text-muted-2"> ({x.reason})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How a version was made, in neutral words: an automatic round never shows its review notes. */
export function versionHow(changeSummary: string | null | undefined, source: string): string {
  const s = (changeSummary ?? "").trim();
  if (/^(Auto-fixed|Creative review:|Automatic check:|Trimmed)/i.test(s)) return "polished by the AI after its own review";
  if (s) return s.replace(/\s+/g, " ").slice(0, 200);
  return source.toLowerCase().replace(/_/g, " ");
}

export type WriterNotesProps = {
  versionNo: number | null;
  how: string | null;
  madeAt: string | null;
  madeBy: string | null;
  words: number | null;
  seconds: number | null;
  skit: boolean;
  approved: string | null;
  released: string | null;
  sourceFile: string | null;
  answersChanged?: boolean;
  formatNote?: string | null;
  angle?: Record<string, string> | null;
  writer?: WriterCardUi | null;
  gaps?: { kind: string; text: string; question: string | null }[];
};

export function WriterNotes(p: WriterNotesProps) {
  const w = p.writer ?? null;
  return (
    <details data-writer-notes className="mt-3 border-t border-border pt-2 text-[11px] text-muted">
      <summary className="cursor-pointer select-none text-muted-2 hover:text-muted">Writer&rsquo;s notes</summary>
      <div className="mt-1.5 space-y-1">
        <p>
          {p.versionNo != null ? `Version ${p.versionNo}` : "Version"}{p.how ? ` · ${p.how}` : ""}{p.madeAt ? ` · ${p.madeAt}` : ""}{p.madeBy ? ` by ${p.madeBy}` : ""}
          {p.approved ? ` · approved ${p.approved}` : ""}{p.released ? ` · sent ${p.released}` : ""}{p.sourceFile ? ` · from ${p.sourceFile}` : ""}
        </p>
        {p.words != null && <p>{p.words} spoken words, about {p.seconds ?? "?"} seconds{p.skit ? " (speakers and directions are not counted)" : ""}.</p>}
        {p.answersChanged && <p>The client edited an answer after this draft. &ldquo;Ask AI to revise&rdquo; (under More) writes from the new answer.</p>}
        {p.formatNote && <p>{p.formatNote}</p>}
        {p.angle && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            {ANGLE_LABELS.filter(([k]) => p.angle?.[k]).map(([k, label]) => (
              <div key={k} className="contents"><dt className="font-medium">{label}</dt><dd>{p.angle?.[k]}</dd></div>
            ))}
          </dl>
        )}
        {w?.rationale && (
          <div>
            {w.rationale.hook && <p><span className="font-semibold">Hook:</span> {w.rationale.hook}</p>}
            {w.rationale.takeaway && <p><span className="font-semibold">Takeaway:</span> {w.rationale.takeaway}</p>}
            {w.rationale.strategy && <p><span className="font-semibold">Her strategy:</span> {w.rationale.strategy}</p>}
          </div>
        )}
        {w && (
          <div>
            <p><span className="font-semibold">The message:</span> {w.brief.centralMessage}</p>
            <p><span className="font-semibold">Viewer:</span> {w.brief.viewer}</p>
            <p><span className="font-semibold">Why this topic:</span> {w.brief.whyChosen}</p>
            {w.brief.pillar && <p><span className="font-semibold">Pillar:</span> {w.brief.pillar}</p>}
            <p><span className="font-semibold">Close:</span> {w.brief.closeType === "callback" ? "a callback to the hook" : "a warm invitation tied to the message"}{w.brief.closeWhy ? `. ${w.brief.closeWhy}` : ""}</p>
            {w.brief.whatSheSaid.length > 0 && (
              <div className="mt-1">
                <p className="font-semibold">What she said</p>
                <ul className={LIST}>{w.brief.whatSheSaid.map((q, i) => <li key={i}>&ldquo;{q.quote}&rdquo; <span className="text-muted-2">({q.source})</span></li>)}</ul>
              </div>
            )}
            <Items label="Kept (points)" xs={w.brief.mustKeep} />
            <Items label="Her phrases worth saying exactly" xs={w.brief.herPhrases ?? []} />
            <Items label="Optional" xs={w.brief.optional} />
            <Items label="Left out" xs={w.brief.excluded} />
            <Items label="Points that disagree" xs={w.brief.contradictions} />
            <Items label="Facts" xs={w.brief.verifiedFacts} />
            <Items label="Her opinions" xs={w.brief.opinions} />
            <Items label="Her creative ideas" xs={w.brief.creativeIdeas} />
            <Items label="Our assumptions (never a claim source)" xs={w.brief.ourAssumptions} />
            {w.hooks.length > 0 && (
              <div className="mt-1">
                <p className="font-semibold">Hooks considered</p>
                <ul className={LIST}>
                  {w.hooks.map((h, i) => (
                    <li key={i} className={h.chosen ? "font-medium text-foreground" : ""}>
                      {h.chosen ? "Chosen: " : ""}{h.text} <span className="text-muted-2">({h.total}/{h.max}{h.disqualified ? `, set aside: ${h.disqualified}` : ""})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {(p.gaps ?? []).length > 0 && (
          <div>
            <p className="font-semibold">Not in her sources yet</p>
            <ul className={LIST}>{(p.gaps ?? []).map((g, i) => <li key={i}>{g.text}{g.question ? ` (to ask: ${g.question})` : ""}</li>)}</ul>
          </div>
        )}
      </div>
    </details>
  );
}
