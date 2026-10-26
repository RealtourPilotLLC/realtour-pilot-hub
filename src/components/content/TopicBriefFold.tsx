"use client";

import { useState, useTransition } from "react";
import { ClipboardCopy, Loader2, MessageSquareText, PenLine, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { buildTopicBriefsAction, saveTopicBriefEditAction } from "@/app/content/actions";

// ---------------------------------------------------------------------------
// WHAT THE AGENT SAID, IN THE OFFICE (Oct 26 2026). Jordan: "I want to see a
// summary of what the agent said about the topic or what they said for
// answered questions if they went that route." Before the hub, ChatGPT read
// the strategy call and wrote, per chosen topic, a detailed summary of what
// the agent said; his Scripting GPT wrote each script from it. The hub writes
// those summaries now (lib/scriptWriter/topicBrief); this file shows them:
//
//   TopicBriefFold    "What <first> said", a closed fold on each of the
//                     month's chosen topics (TopicsPanel) and on the script
//                     card above the Writer's notes (ScriptsPanel): the
//                     summary, where it came from ("From the October 20 call"
//                     / "From Erica's written answers", "edited by ..."),
//                     Edit (Save / Cancel / Back to the AI's version) and, on
//                     the topic, Summarize again. None yet: "No summary yet."
//                     with Summarize the call.
//   CallSummaryCard   above the month's topics: the opening line, the main
//                     request, the topics held for later, Copy all (the whole
//                     month in Jordan's layout, the office's edits included)
//                     and Summarize the call.
//
// One model call reads the call once for every topic that needs it, so a
// press anywhere summarizes every chosen topic still missing one. Staff only;
// nothing here reaches the portal.
// ---------------------------------------------------------------------------

/** One chosen topic's current summary, as the office reads it. */
export type TopicBriefUi = {
  briefId: string;
  /** The topic's title as the summary carries it (its first line, which the fold leaves off). */
  title: string;
  /** The office's wording when edited, else the AI's summary in Jordan's layout. */
  text: string;
  route: "CALL" | "WRITTEN";
  edited: boolean;
  editedBy: string | null;
  /** False when the call never covered it and there are no written answers. */
  discussed: boolean;
  createdAt: string;
  /** "October 20": the call it was written from, when there was one. */
  callDate: string | null;
};

/** The month's summaries: the header, every chosen topic (null = none yet), and the whole month as text. */
export type MonthBriefsUi = {
  monthId: string;
  /** The month's chosen topics, in their order. */
  chosenIds: string[];
  header: { opening: string; mainRequest: string | null; held: { title: string; why: string }[]; callDate: string | null } | null;
  /** By topic id: every chosen topic (null while it has none) and any other topic of the month with one. */
  byTopic: Record<string, TopicBriefUi | null>;
  /** "Copy all": the month in Jordan's layout (monthBriefText), the office's edits in place of the AI's words. */
  copyText: string | null;
};

type Said = { ok: boolean; message: string };

const btn = "rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50";
const quiet = "rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 disabled:opacity-50";
const READING = "Reading the call… this takes about a minute";
const OFFLINE: Said = { ok: false, message: "Couldn't reach the server. Try again." };

/** The summary as the fold shows it: the topic's own title line taken off (the row already says it), bullets as dots. */
export function briefBody(text: string, title: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = (lines[0] ?? "").trim().replace(/^\d+\.\s+/, "");
  const body = title.trim() && first === title.trim() ? lines.slice(1).join("\n") : text;
  return body.replace(/^\* /gm, "• ").trim();
}

/** "From the October 20 call" / "From Erica's written answers", and who edited it. */
export function briefSourceLine(b: Pick<TopicBriefUi, "route" | "callDate" | "edited" | "editedBy">, clientFirst: string): string {
  const from = b.route === "WRITTEN" ? `From ${clientFirst}'s written answers` : b.callDate ? `From the ${b.callDate} call` : "From the strategy call";
  return b.edited ? `${from}, edited by ${b.editedBy || "the office"}` : from;
}

/**
 * "What <first> said" on one topic (variant "topic") or on its script card
 * (variant "card": read and Edit only, never a model call from the card).
 */
export function TopicBriefFold({ topicId, monthId, brief, clientFirst, variant = "topic" }: {
  topicId?: string | null;
  /** The month the topic is chosen on; Summarize is offered only with it. */
  monthId: string | null;
  brief: TopicBriefUi | null;
  clientFirst: string;
  variant?: "topic" | "card";
}) {
  const who = clientFirst || "the client";
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState("");
  const [said, setSaid] = useState<Said | null>(null);
  const [saving, startSave] = useTransition();
  const [reading, startRead] = useTransition();
  const canSummarize = variant === "topic" && !!monthId;
  const startEdit = () => { setDraft(brief?.text ?? ""); setSaid(null); setMode("edit"); };
  const save = (text: string) => {
    if (!brief) return;
    // Saving the words it already has changes nothing (and never marks the AI's version as edited).
    if (text.trim() && text.trim() === brief.text.trim()) { setMode("read"); return; }
    startSave(async () => {
      let r: Said;
      try { r = await saveTopicBriefEditAction(brief.briefId, text); } catch { r = OFFLINE; }
      setSaid(r);
      if (r.ok) setMode("read");
    });
  };
  const summarize = (again: boolean) => {
    if (!monthId) return;
    if (again && brief?.edited && !window.confirm("Summarize this topic again from the call? The new summary replaces your edited wording.")) return;
    setSaid(null);
    startRead(async () => {
      let r: Said;
      try { r = again && topicId ? await buildTopicBriefsAction(monthId, [topicId], true) : await buildTopicBriefsAction(monthId); } catch { r = OFFLINE; }
      setSaid(r);
    });
  };
  const body = brief ? briefBody(brief.text, brief.title) : "";
  return (
    <details data-topic-brief={topicId ?? ""} data-brief-id={brief?.briefId ?? ""}
      className={variant === "card" ? "mt-3 border-t border-border pt-2 text-[12px]" : "mt-1.5 rounded-lg border border-border bg-surface-2/40 px-3 py-1.5 text-[12px]"}>
      <summary className="cursor-pointer select-none text-[12px] font-medium text-muted hover:text-foreground">
        What {who} said{!brief && <span className="font-normal text-muted-2"> · no summary yet</span>}
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {brief ? (
          <>
            <p className="text-[11px] text-muted-2" data-brief-source>{briefSourceLine(brief, who)}</p>
            {mode === "edit" ? (
              <div>
                <AutoTextarea aria-label={`What ${who} said`} value={draft} onChange={(e) => setDraft(e.target.value)} minRows={6} maxRows={24}
                  className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-base leading-relaxed sm:text-xs" />
                <p className="mt-1 text-[11px] text-muted-2">Your wording takes the place of the AI&rsquo;s, for the office and for the script writer.</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <button disabled={saving || !draft.trim()} onClick={() => save(draft)} className={`${btn} min-h-9 bg-brand-action text-white`}>Save</button>
                  <button disabled={saving} onClick={() => setMode("read")} className={`${quiet} min-h-9`}>Cancel</button>
                  {brief.edited && <button disabled={saving} onClick={() => save("")} className={`${quiet} min-h-9`}><Undo2 className="mr-1 inline size-3" />Back to the AI&rsquo;s version</button>}
                </div>
              </div>
            ) : brief.discussed || brief.edited ? (
              <div className="whitespace-pre-wrap leading-relaxed text-foreground/90" data-brief-text>{body}</div>
            ) : (
              <p className="text-muted" data-brief-text>{who} didn&rsquo;t talk about this topic on the call, and there are no written answers for it yet.</p>
            )}
            {mode === "read" && (
              <div className="flex flex-wrap gap-1.5">
                <button onClick={startEdit} className={`${quiet} min-h-9`}><PenLine className="mr-1 inline size-3" />Edit</button>
                {canSummarize && <button disabled={reading} onClick={() => summarize(true)} className={`${quiet} min-h-9`}><RefreshCw className="mr-1 inline size-3" />Summarize again</button>}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-muted" data-brief-text>No summary yet.</p>
            {canSummarize && <button disabled={reading} onClick={() => summarize(false)} className={`${quiet} min-h-9`}><Sparkles className="mr-1 inline size-3" />Summarize the call</button>}
          </>
        )}
        {reading && <p className="text-[12px] text-muted"><Loader2 className="mr-1 inline size-3 animate-spin" />{READING}</p>}
        {said && !reading && <p role="status" className="text-[12px] text-muted">{said.message}</p>}
      </div>
    </details>
  );
}

/**
 * The month's call, summarized: the opening line, the main request, what was
 * held for later, Copy all and Summarize the call. The page leaves it off a
 * month with no chosen topics.
 */
export function CallSummaryCard({ monthId, clientFirst, briefs }: { monthId: string; clientFirst: string; briefs: MonthBriefsUi }) {
  const who = clientFirst || "the client";
  const [reading, start] = useTransition();
  const [said, setSaid] = useState<Said | null>(null);
  const [copied, setCopied] = useState(false);
  const h = briefs.header;
  const chosen = briefs.chosenIds.length;
  const done = briefs.chosenIds.filter((id) => !!briefs.byTopic[id]).length;
  const copy = async () => {
    if (!briefs.copyText) return;
    try {
      await navigator.clipboard.writeText(briefs.copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setSaid({ ok: false, message: "Couldn't copy here. Each topic's summary is below, under its topic." });
    }
  };
  const summarize = () => {
    setSaid(null);
    start(async () => {
      let r: Said;
      try { r = await buildTopicBriefsAction(monthId); } catch { r = OFFLINE; }
      setSaid(r);
    });
  };
  const where = `Each one is under its topic below, in "What ${who} said".`;
  return (
    <div data-call-summary={monthId}>
      <Section icon={MessageSquareText} title="Call summary"
        action={
          <span className="flex flex-wrap items-center gap-1.5">
            {briefs.copyText && (
              <button onClick={copy} className={`${quiet} inline-flex min-h-9 items-center`} aria-live="polite"><ClipboardCopy className="mr-1 size-3" />{copied ? "Copied" : "Copy all"}</button>
            )}
            <button disabled={reading} onClick={summarize} className={`${btn} inline-flex min-h-9 items-center bg-brand-action text-white`}>
              {reading ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Sparkles className="mr-1 size-3" />}Summarize the call
            </button>
          </span>
        }>
        <div className="space-y-1.5 text-[13px] leading-relaxed">
          {h?.opening && <p data-brief-opening>{h.opening}</p>}
          {h?.mainRequest && <p><span className="font-semibold">Main request:</span> {h.mainRequest}</p>}
          {h && h.held.length > 0 && (
            <div className="text-[12px]">
              <p className="font-semibold text-muted">Held for later</p>
              <ul className="mt-0.5 list-inside list-disc text-muted">
                {h.held.map((x, i) => <li key={i}><span className="text-foreground">{x.title}</span>{x.why ? `: ${x.why}` : ""}</li>)}
              </ul>
            </div>
          )}
          <p className="text-[12px] text-muted">
            {done === 0 ? `No summary yet. Summarize the call to see what ${who} said about each topic.`
              : done < chosen ? `${done} of ${chosen} topics summarized. ${where}`
              : `Every topic is summarized. ${where}`}
          </p>
          {reading && <p className="text-[12px] text-muted"><Loader2 className="mr-1 inline size-3 animate-spin" />{READING}</p>}
          {said && !reading && <p role="status" className="text-[12px] text-muted">{said.message}</p>}
        </div>
      </Section>
    </div>
  );
}
