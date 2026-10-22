"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Clapperboard, Download, Loader2, MessageSquare, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalApproveScript, portalEditApprovedScript, portalRequestScriptChanges, portalScriptPdfLink, portalSendPartChanges } from "@/app/portal/actions";
import { ScriptWordsEditor, type EditableParts } from "@/components/script/ScriptWordsEditor";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { PortalTopic } from "@/lib/portal";
import type { PortalScriptUpdate } from "@/lib/scriptRequests";
import { CTA_WORDS } from "@/lib/portalWords";

// ---------------------------------------------------------------------------
// THE CLIENT'S OWN VERDICT ON A SCRIPT (F09) — one component, lifted verbatim
// out of TopicBank (UI-01, Sep 24 2026) so the topic bank and My Plan's
// Scripts view send the decision the same way.
//
// R1 — the decision carries the version THIS PAGE rendered (sharedVersionId).
// If a newer one has been released since, the server refuses and the page
// refreshes, so the client lands on the words we would actually film instead
// of approving something they have not read. Never call the actions without
// it; a second copy of this block is how that guard would get lost.
//
// Two ways to report back: inside TopicBank (v1) the bank's own status line
// and transition (`onResult` + `run`); standing alone (v2), the result shows
// beside these buttons — "saving", then what happened — and a failure keeps
// the client's words so "try again" is one tap.
//
// "TRY AGAIN" ONLY WHEN TRYING AGAIN CAN WORK (Sep 24). It used to follow any
// refusal, and the closure it kept carried the version id of the render that
// failed — so after a stale-version refusal (a newer version released while
// the tab was open) the refresh put the new words on screen while "Try again"
// re-sent the OLD id and met the same refusal, forever, beside words the
// client had just been told to re-read. Now it is offered only when the
// request never got an answer (the network), and only while the version on
// screen is still the one it would send.
//
// TWO WAYS TO ASK FOR A CHANGE (Oct 22 2026, the design Jordan approved,
// mock-script-requests Main / Portal-Part / Portal-Message / Portal-Updated):
//   · "Change this part": one or more parts (hook, a talking point, the close)
//     in their own words beside ours, each with an optional note, sent as one
//     request (decision 6);
//   · "Ask for a change in your own words": a message, about the whole script,
//     the title, the hook or the close (a pasted rewrite is welcome).
// Neither changes the script: Jordan reads it and sends back an updated
// version, which comes back here with the parts that changed marked and his
// message on top (`update`).
// ---------------------------------------------------------------------------

export type ScriptVerdict = NonNullable<PortalTopic["script"]>;
type R = { ok: boolean; message: string };
/** `transport`: the request never reached an answer — the one failure a plain retry can fix. */
type Outcome = R & { transport?: boolean };
type PartKey = "hook" | "point1" | "point2" | "point3" | "point4" | "close";
type About = "whole" | "title" | "hook" | "close";
const ABOUT: { key: About; label: string }[] = [{ key: "whole", label: "The whole script" }, { key: "title", label: "Title" }, { key: "hook", label: "Hook" }, { key: "close", label: "Close" }];
const ROLE: Record<string, string> = { "re-hook": "Re-hook", "build-up": "Build up", payoff: "Payoff" };
/** Who reads their change (the creative director, by name, as on the approved design). */
const READER = "Jordan";

const keysOf = (p: EditableParts): PartKey[] => ["hook", ...p.points.map((_, i) => `point${i + 1}` as PartKey), "close"];
const textOf = (p: EditableParts, k: PartKey) => (k === "hook" ? p.hook : k === "close" ? p.close : p.points[Number(k.slice(5)) - 1]?.text ?? "");
const labelOf = (p: EditableParts, k: PartKey) => {
  if (k === "hook") return "Hook";
  if (k === "close") return "Close";
  const i = Number(k.slice(5)) - 1;
  const role = p.points[i]?.role;
  return `Talking point ${i + 1}${role ? ` · ${ROLE[role]}` : ""}`;
};
const shortName = (k: PartKey) => (k === "hook" ? "hook" : k === "close" ? "close" : `talking point ${Number(k.slice(5))}`);
const nameList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function ScriptApprovalCard({ script, parts = null, onResult, run, busy: parentBusy, large = false, canApprove = true, inlineParts = false, update = null }: {
  script: ScriptVerdict;
  /** Oct 20 2026 (audit E1): approving, and editing an approved script, are the
   *  account owner's. Everyone else may suggest wording and ask for changes. */
  canApprove?: boolean;
  /** Oct 14 2026: the words of the version on the page, so the client can edit them once they approve. */
  parts?: EditableParts | null;
  /** The parent's status line (TopicBank v1). Absent → the result renders here. */
  onResult?: (r: R) => void;
  /** The parent's transition, so every button on the bank disables together. */
  run?: (fn: () => Promise<void>) => void;
  busy?: boolean;
  /** 44px touch targets (v2). */
  large?: boolean;
  /** Oct 22 2026: the card shows the parts itself, each with "Change this part" (the Scripts view). */
  inlineParts?: boolean;
  /** Oct 22 2026: this version answered their request: the parts that changed are marked. */
  update?: PortalScriptUpdate | null;
}) {
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [about, setAbout] = useState<About[]>([]);
  const [own, setOwn] = useState<{ ok: boolean; text: string } | null>(null);
  /** The send that never got an answer, and the version it carries — "Try again" repeats it only while that version is still on screen. */
  const [retry, setRetry] = useState<{ fn: () => void; versionId: string | null } | null>(null);
  const [ownBusy, startOwn] = useTransition();
  const busy = parentBusy ?? ownBusy;
  const start = run ?? ((fn: () => Promise<void>) => startOwn(fn));
  const done = (r: Outcome, again: () => void) => {
    if (onResult) { onResult({ ok: r.ok, message: r.message }); return; }
    setOwn({ ok: r.ok, text: r.message });
    // An object, never the bare function: React would CALL a function passed
    // to a state setter as an updater.
    setRetry(!r.ok && r.transport ? { fn: again, versionId: script.sharedVersionId ?? null } : null);
    // Refreshed either way: a refusal is most often a newer version released
    // since this page loaded (R1), and the reload is what puts it in front of them.
    router.refresh();
  };
  const approve = () =>
    start(async () => {
      setOwn(null);
      done(await portalApproveScript(portalAuthFromLocation(), script.id, script.sharedVersionId ?? "").catch((): Outcome => ({ ok: false, message: "That didn't save. Try again.", transport: true })), approve);
    });
  const sendChanges = () =>
    start(async () => {
      setOwn(null);
      const r: Outcome = await portalRequestScriptChanges(portalAuthFromLocation(), script.id, changeNote, script.sharedVersionId ?? "", about).catch((): Outcome => ({ ok: false, message: "That didn't send. Try again.", transport: true }));
      // A stale refusal keeps their words in the box: they are about to read a
      // new version and may well want to say the same thing about it.
      if (r.ok) { setChangeNote(""); setAbout([]); setChanging(false); }
      done(r, sendChanges);
    });
  // Audit E8: a phone needs a real target even on the compact card.
  const btn = large ? "min-h-11 rounded-xl px-4 text-sm" : "min-h-9 px-2.5 text-xs";
  // AFTER THEY APPROVE (Oct 14 2026, Jordan): the PDF and their own edits.
  const [editing, setEditing] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const downloadPdf = async () => {
    setPdfBusy(true);
    setOwn(null);
    const r = await portalScriptPdfLink(portalAuthFromLocation(), script.id).catch(() => ({ ok: false, message: "That didn't work. Try again.", url: undefined }));
    setPdfBusy(false);
    if (r.ok && r.url) window.location.assign(r.url);
    else setOwn({ ok: false, text: r.message });
  };
  const saveWords = async (w: { hook: string; points: string[]; close: string; captionCta?: string | null }) => portalEditApprovedScript(portalAuthFromLocation(), script.id, script.sharedVersionId ?? "", w);

  // "CHANGE THIS PART" (Oct 22 2026): the parts open for changing, their new words and notes.
  const [open, setOpen] = useState<PartKey[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const openPart = (k: PartKey) => {
    if (!parts) return;
    setChanging(false);
    setOwn(null);
    setOpen((o) => (o.includes(k) ? o : [...o, k]));
    setDraft((d) => (k in d ? d : { ...d, [k]: textOf(parts, k) }));
  };
  const closePart = (k: PartKey) => setOpen((o) => o.filter((x) => x !== k));
  const changedOpen = parts ? open.filter((k) => (draft[k] ?? "").replace(/\s+/g, " ").trim() !== textOf(parts, k).replace(/\s+/g, " ").trim()) : [];
  const sendParts = () =>
    start(async () => {
      setOwn(null);
      const r: Outcome = await portalSendPartChanges(portalAuthFromLocation(), script.id, script.sharedVersionId ?? "", changedOpen.map((k) => ({ part: k, text: draft[k] ?? "", note: notes[k]?.trim() || null })))
        .catch((): Outcome => ({ ok: false, message: "That didn't send. Try again.", transport: true }));
      if (r.ok) { setOpen([]); setDraft({}); setNotes({}); }
      done(r, sendParts);
    });
  const replies = (script.replies ?? []).filter((m) => !(update?.message && m.atISO === update.message.atISO));
  const pill = cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn);
  const box = "mt-1 block w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-base leading-relaxed outline-none focus:border-brand sm:text-sm";
  const canChange = !!parts;

  /** The parts, each with "Change this part"; the ones this version changed are marked. */
  const partsList = parts && (
    <div className="space-y-1.5">
      {update?.changed.includes("title") && (
        <div className="rounded-xl bg-surface-2/60 px-3 py-2">
          <div className="flex items-center gap-2"><span className="text-[10.5px] font-bold uppercase tracking-wider text-muted-2">Title</span><span className="rounded-full bg-brand-soft px-2 text-[10.5px] font-semibold text-brand">Updated</span></div>
          <p className="mt-0.5 text-sm leading-relaxed">{update.title}</p>
        </div>
      )}
      {keysOf(parts).map((k) => (
        <div key={k} className={cn("rounded-xl bg-surface-2/60 px-3 py-2", update?.changed.includes(k) && "ring-1 ring-brand/30")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted-2">{labelOf(parts, k)}</span>
              {update?.changed.includes(k) && <span className="rounded-full bg-brand-soft px-2 text-[10.5px] font-semibold text-brand">Updated</span>}
            </span>
            {canChange && <button type="button" onClick={() => openPart(k)} disabled={busy} className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-surface px-2.5 text-xs font-semibold text-brand disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><PencilLine className="size-3" aria-hidden /> Change this part</button>}
          </div>
          <p className="mt-0.5 text-sm leading-relaxed">{textOf(parts, k)}</p>
        </div>
      ))}
      {parts.captionCta && (
        <div className="rounded-xl bg-surface-2/60 px-3 py-2">
          <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted-2">Caption</span>
          <p className="mt-0.5 text-sm leading-relaxed">{parts.captionCta}</p>
        </div>
      )}
    </div>
  );

  /** Portal-Part: the parts being changed open, the rest folded, one Send. */
  const partsEditor = parts && open.length > 0 && (
    <div className="mt-2 space-y-2 rounded-xl border border-brand/30 bg-surface p-3">
      {keysOf(parts).filter((k) => open.includes(k)).map((k) => (
        <div key={k} className="space-y-1.5 rounded-xl bg-surface-2/40 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-brand">{labelOf(parts, k)} · your wording</span>
            <button type="button" onClick={() => closePart(k)} disabled={busy} className="min-h-9 text-xs text-muted hover:text-foreground">Keep it as it is</button>
          </div>
          <div>
            <div className="text-[11px] font-semibold text-muted">Now it says</div>
            <p className="text-sm leading-relaxed text-muted">{textOf(parts, k)}</p>
          </div>
          <label className="block">
            <span className="text-xs font-semibold">Your new {shortName(k)}</span>
            <textarea value={draft[k] ?? ""} onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, [k]: v })); setRetry(null); setOwn(null); }} rows={3} className={box} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold">Anything we should know? <span className="font-normal text-muted">(optional)</span></span>
            <textarea value={notes[k] ?? ""} onChange={(e) => { const v = e.target.value; setNotes((n) => ({ ...n, [k]: v })); }} rows={2} placeholder="For example: I want it to sound more like a question" className={box} />
          </label>
        </div>
      ))}
      {keysOf(parts).some((k) => !open.includes(k)) && (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-muted">+ Change another part too</div>
          {keysOf(parts).filter((k) => !open.includes(k)).map((k) => (
            <button key={k} type="button" onClick={() => openPart(k)} disabled={busy} className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border px-2.5 text-left text-xs hover:border-brand/40 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
              <span className="shrink-0 font-semibold">{labelOf(parts, k)}</span>
              <span className="min-w-0 truncate text-muted">{textOf(parts, k)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={sendParts} disabled={busy || changedOpen.length === 0} className={cn("inline-flex items-center gap-1 rounded-lg bg-brand-action font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}>
          {busy && <Loader2 className="size-3 animate-spin" />} {changedOpen.length > 1 ? `Send my changes (${nameList(changedOpen.map((k) => shortName(k)))})` : `Send my change${changedOpen.length ? ` (${shortName(changedOpen[0])})` : ""}`}
        </button>
        <button type="button" onClick={() => { setOpen([]); setDraft({}); setNotes({}); }} disabled={busy} className={pill}>Cancel</button>
      </div>
      <p className="text-[11px] text-muted">{READER} looks at your wording and sends back an updated version for your OK. The rest of the script stays as it is.</p>
    </div>
  );

  // FILMED, NEVER APPROVED (Oct 22 2026, Jordan: "he shouldn't have to approve
  // it. It should just show up as filmed."). Read-only: no approve, no change
  // request, no edit. Filmed is not their sign-off, so nothing says they gave one.
  const filmedOnly = !!script.filmed && script.decision !== "APPROVED";
  const filmedOn = script.filmed?.atISO ? new Date(script.filmed.atISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null;

  return (
    <div className={cn("mt-3 border-t border-border pt-3", large && "space-y-2", inlineParts && !script.decision && !filmedOnly && "border-t-0 pt-0")}>
      {filmedOnly ? (
        <>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-success"><Clapperboard className="size-3.5" aria-hidden /> Filmed{filmedOn ? ` on ${filmedOn}` : ""}.</p>
          <p className="mt-1 text-[11px] text-muted">
            {script.decision === "CHANGES_REQUESTED"
              ? <>We filmed this one, so there&rsquo;s nothing for you to approve. {READER} has the changes you asked for. You can still read it and download it as a PDF.</>
              : <>We filmed this one, so there&rsquo;s nothing for you to approve. You can still read it and download it as a PDF.</>}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={downloadPdf} disabled={pdfBusy || busy} className={pill}>{pdfBusy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} Download PDF</button>
          </div>
        </>
      ) : script.decision === "APPROVED" ? (
        <>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-success"><CheckCheck className="size-3.5" /> You signed off on this one{script.decidedAtISO ? ` on ${new Date(script.decidedAtISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}` : ""}.</p>
          <p className="mt-1 text-[11px] text-muted">It&rsquo;s yours now: you can change the wording yourself any time before we film, and download it as a PDF to practice with.</p>
          {!editing && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={downloadPdf} disabled={pdfBusy || busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}>{pdfBusy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} Download PDF</button>
              {parts && canApprove && <button type="button" onClick={() => { setEditing(true); setOwn(null); }} disabled={busy} className={pill}><PencilLine className="size-3" /> Edit the wording</button>}
            </div>
          )}
          {editing && parts && (
            <ScriptWordsEditor
              parts={parts}
              intro="Change any line to say it your way. Keep a hook, each talking point and a close. What you save is the version we film."
              onSave={saveWords}
              onCancel={() => setEditing(false)}
              onSaved={(m) => { setEditing(false); setOwn({ ok: true, text: m }); router.refresh(); }}
            />
          )}
        </>
      ) : script.decision === "CHANGES_REQUESTED" ? (
        <>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning"><PencilLine className="size-3.5" /> You asked for changes. {READER} is looking at them, and the updated version lands here for your OK.</p>
          {/* Oct 20 2026 (audit E14): changed their mind? The server already takes it back. */}
          {canApprove && (
            <button type="button" onClick={approve} disabled={busy} className={cn("mt-1.5", pill)}><CheckCheck className="size-3" /> Approve as written instead</button>
          )}
        </>
      ) : (
        <>
          {script.staleApproval && <p className="mb-1.5 text-[11px] text-muted">We&rsquo;ve rewritten this since you last approved it. Have another read.</p>}
          {inlineParts && open.length === 0 && partsList}
          {partsEditor}
          {open.length === 0 && (
            <>
              {!changing && (
                <div className={cn("flex flex-wrap items-center gap-1.5", inlineParts && "mt-2.5")}>
                  {canApprove && <button type="button" onClick={approve} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", btn)}><CheckCheck className="size-3" /> {CTA_WORDS.APPROVE}</button>}
                  <span role="group" aria-label={CTA_WORDS.CHANGES} className="contents">
                    {/* The parts are on screen with their own buttons in the Scripts view; elsewhere this opens the hook first. */}
                    {canChange && !inlineParts && <button type="button" onClick={() => openPart("hook")} disabled={busy} className={pill}><PencilLine className="size-3" /> Change a part</button>}
                    <button type="button" onClick={() => { setChanging(true); setOwn(null); }} disabled={busy} className={pill}><MessageSquare className="size-3" /> Ask for a change in your own words</button>
                  </span>
                  {!onResult && busy && <span role="status" className="inline-flex items-center gap-1 text-[11px] text-muted"><Loader2 className="size-3 animate-spin" /> Saving…</span>}
                </div>
              )}
              <p className="mt-1.5 text-[11px] text-muted">
                {canApprove
                  ? <>Reword one section with &ldquo;Change this part&rdquo;, or tell us what you&rsquo;d like changed and we&rsquo;ll take it from there. Once it&rsquo;s approved you can download it as a PDF and edit the wording yourself.</>
                  : <>Reword one section with &ldquo;Change this part&rdquo;, or tell us what you&rsquo;d like changed. The account owner approves scripts.</>}
              </p>
            </>
          )}
          {/* Portal-Message: a free note, about part of the script or all of it. */}
          {changing && (
            <div className="mt-2 rounded-xl border border-border bg-surface-2/40 p-3">
              <p className="text-sm font-semibold">Ask for a change</p>
              <label htmlFor={`script-changes-${script.id}`} className="mt-1.5 block text-xs font-semibold">What would you like changed?</label>
              <textarea id={`script-changes-${script.id}`} value={changeNote} onChange={(e) => { setChangeNote(e.target.value); setRetry(null); setOwn(null); }} rows={large ? 5 : 4} placeholder="For example: make the hook about first-time buyers" className={box} />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-muted">About:</span>
                {ABOUT.map((a) => {
                  const on = about.includes(a.key);
                  return <button key={a.key} type="button" aria-pressed={on} onClick={() => setAbout((x) => (on ? x.filter((y) => y !== a.key) : [...x, a.key]))} className={cn("inline-flex min-h-9 items-center rounded-full border px-3 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", on ? "border-brand bg-brand-soft font-semibold text-brand" : "border-border text-muted hover:text-foreground")}>{a.label}</button>;
                })}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={sendChanges} disabled={busy || changeNote.trim().length < 3} className={cn("min-h-9 rounded-lg bg-brand-action px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", large ? "min-h-11 px-4 text-sm" : "")}>Send to {READER}</button>
                <button type="button" onClick={() => setChanging(false)} disabled={busy} className={cn("min-h-9 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", large ? "min-h-11 px-4 text-sm" : "")}>Cancel</button>
              </div>
              <p className="mt-1.5 text-[11px] text-muted">{READER} replies right here and sends you an updated version for your OK. You can also paste a whole rewrite: we&rsquo;ll read it as your wording.</p>
            </div>
          )}
        </>
      )}
      {/* Oct 20 2026: what we wrote back about this script. */}
      {replies.length > 0 && (
        <ul className="mt-2 space-y-1.5 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2">
          {replies.map((m, i) => (
            <li key={i} className="text-xs">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-2">{m.by} · {new Date(m.atISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}</span>
              <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
      {/* Standing alone, the answer sits beside the buttons that produced it. */}
      {!onResult && own && (
        <p role="status" className={cn("mt-1.5 flex flex-wrap items-center gap-2 text-xs", own.ok ? "text-success" : "text-danger")}>
          {own.text}
          {!own.ok && retry && retry.versionId === (script.sharedVersionId ?? null) && <button type="button" onClick={retry.fn} disabled={busy} className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-xs text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Try again</button>}
        </p>
      )}
    </div>
  );
}
