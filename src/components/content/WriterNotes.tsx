"use client";

import { Scissors } from "lucide-react";
import type { WriterCardUi } from "@/lib/scriptWriter/record";
// rules.ts is pure (policy numbers only), so the card reads the same cap, aim
// and trim instruction the writer and the reviewer use.
import { lengthLabel, trimInstruction, WRITER_LENGTH } from "@/lib/scriptWriter/rules";

// ---------------------------------------------------------------------------
// WHAT THE NEW WRITER TELLS JORDAN, ON THE SCRIPT CARD (Oct 22 2026). Staff
// only; nothing here reaches the portal.
//
//   length     every non-skit script: over 110 spoken words reads "A bit long:
//              needs a fix" with a one-press AI fix (the trim instruction, a
//              new version; this one is kept); 86 to 110 reads "Longer than the
//              55 to 85 aim" as advice; the estimated seconds either way
//   review     "Creative review: 11 of 12 pass", each failing check with its
//              reason (must-fix or flag), the fix rounds and the trim
//   rationale  the hook, the takeaway, how her strategy shaped it
//   brief      the topic brief, folded: the one message, the viewer, why it
//              was chosen, what she said (verbatim, with source and time),
//              must-keep, optional, excluded, contradictions, facts, her
//              opinions and ideas, our assumptions, the close type; and the
//              five hooks with their scores
// ---------------------------------------------------------------------------

const LIST = "mt-0.5 space-y-0.5 pl-3";

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

export function WriterNotes({ writer, words, skit, canFix, busy, onFix }: { writer: WriterCardUi | null | undefined; words: number | null; skit: boolean; canFix: boolean; busy: boolean; onFix: (instruction: string) => void }) {
  const length = !skit && words != null ? lengthLabel(words) : null;
  const showLength = !!length && (length.band === "over" || length.band === "long" || !!writer);
  if (!writer && !showLength) return null;
  const r = writer?.review ?? null;
  // v2.1: the one press trims toward 75 to 80 and names the brief's must-keep points. Over the cap on
  // any script; 86 to 110 only on a script the new writer drafted (its review undoes a trim that lost one).
  const fixable = canFix && !!length && (length.band === "over" || (length.band === "long" && !!writer));
  const mustKeep = (writer?.brief.mustKeep ?? []).map((m) => m.text);
  return (
    <div className="mt-1.5 space-y-1 rounded-lg border border-border bg-surface-2/40 px-2.5 py-1.5 text-[11px]">
      {showLength && length && (
        <p className={`flex flex-wrap items-center gap-1.5 ${length.band === "over" ? "font-medium text-warning" : length.band === "long" ? "text-warning" : "text-muted"}`}>
          <span>{length.text}</span>
          {fixable && (
            <button
              disabled={busy}
              onClick={() => onFix(trimInstruction(words!, mustKeep))}
              title={`Asks the AI for a new version toward ${WRITER_LENGTH.trimTo[0]} to ${WRITER_LENGTH.trimTo[1]} words${length.band === "over" ? ` (${WRITER_LENGTH.cap} at most)` : ""}, dropping none of the brief's must-keep points. This version is kept${writer ? ", and comes back if the trim loses one" : ""}.`}
              className="inline-flex min-h-7 items-center gap-1 rounded-md border border-warning/40 px-2 py-0.5 font-semibold text-warning hover:bg-warning/10 disabled:opacity-50"
            >
              <Scissors className="size-3" />{length.band === "over" ? "Fix with AI" : `Trim toward ${WRITER_LENGTH.trimTo[0]} to ${WRITER_LENGTH.trimTo[1]}`}
            </button>
          )}
        </p>
      )}
      {writer?.lengthNote && <p className="text-muted">{writer.lengthNote}</p>}
      {r && (
        <div>
          {r.note && <p className={r.state === "flagged" ? "font-medium text-warning" : "text-muted"}>{r.note}</p>}
          {r.headline && (
            <p className={r.failing.some((f) => f.level === "must-fix") ? "font-medium text-warning" : "text-success"}>
              {r.headline}
              {r.fixRounds ? ` · auto-fixed ${r.fixRounds} time${r.fixRounds === 1 ? "" : "s"}` : ""}
              {r.trimmed ? " · trimmed" : ""}
            </p>
          )}
          {r.failing.length > 0 && (
            <ul className={LIST}>
              {r.failing.map((f) => (
                <li key={f.n} className={f.level === "must-fix" ? "text-warning" : "text-muted"}>
                  {f.n}. {f.label} ({f.level === "must-fix" ? "must fix" : "flag"}): {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {writer?.rationale && (
        <div className="text-muted">
          {writer.rationale.hook && <p><span className="font-semibold">Hook:</span> {writer.rationale.hook}</p>}
          {writer.rationale.takeaway && <p><span className="font-semibold">Takeaway:</span> {writer.rationale.takeaway}</p>}
          {writer.rationale.strategy && <p><span className="font-semibold">Her strategy:</span> {writer.rationale.strategy}</p>}
        </div>
      )}
      {writer && (
        <details>
          <summary className="cursor-pointer text-muted"><span className="font-semibold">Topic brief:</span> {writer.brief.centralMessage}</summary>
          <div className="mt-1 text-muted">
            <p><span className="font-semibold">Viewer:</span> {writer.brief.viewer}</p>
            <p><span className="font-semibold">Why chosen:</span> {writer.brief.whyChosen}</p>
            {writer.brief.pillar && <p><span className="font-semibold">Pillar:</span> {writer.brief.pillar}</p>}
            <p><span className="font-semibold">Close:</span> {writer.brief.closeType === "callback" ? "a callback to the hook" : "a warm invitation tied to the message"}{writer.brief.closeWhy ? `. ${writer.brief.closeWhy}` : ""}</p>
            <p><span className="font-semibold">Target:</span> about {writer.brief.target.words ?? WRITER_LENGTH.target} words, inside {writer.brief.target.aim[0]} to {writer.brief.target.aim[1]} (about {writer.brief.target.seconds[0]} to {writer.brief.target.seconds[1]} seconds), {writer.brief.target.cap} at most</p>
            {writer.brief.whatSheSaid.length > 0 && (
              <div className="mt-1">
                <p className="font-semibold">What she said</p>
                <ul className={LIST}>{writer.brief.whatSheSaid.map((q, i) => <li key={i}>&ldquo;{q.quote}&rdquo; <span className="text-muted-2">({q.source})</span></li>)}</ul>
              </div>
            )}
            <Items label="Must keep (points)" xs={writer.brief.mustKeep} />
            <Items label="Her phrases worth saying exactly" xs={writer.brief.herPhrases ?? []} />
            <Items label="Optional" xs={writer.brief.optional} />
            <Items label="Left out" xs={writer.brief.excluded} />
            <Items label="Contradictions (flagged, not resolved)" xs={writer.brief.contradictions} />
            <Items label="Verified facts" xs={writer.brief.verifiedFacts} />
            <Items label="Her opinions" xs={writer.brief.opinions} />
            <Items label="Her creative ideas" xs={writer.brief.creativeIdeas} />
            <Items label="Our assumptions (never a claim source)" xs={writer.brief.ourAssumptions} />
            {writer.hooks.length > 0 && (
              <div className="mt-1">
                <p className="font-semibold">Hooks considered</p>
                <ul className={LIST}>
                  {writer.hooks.map((h, i) => (
                    <li key={i} className={h.chosen ? "font-medium text-foreground" : ""}>
                      {h.chosen ? "Chosen: " : ""}{h.text} <span className="text-muted-2">({h.total}/35{h.disqualified ? `, set aside: ${h.disqualified}` : ""})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {r && r.passing.length > 0 && <p className="mt-1 text-muted-2">Passing checks: {r.passing.map((p) => `${p.n}. ${p.label}`).join(", ")}</p>}
          </div>
        </details>
      )}
    </div>
  );
}
