"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, CalendarClock, CheckCheck, Loader2, RotateCcw, Undo2, X } from "lucide-react";
import {
  dismissSavedRequestAction, placeSavedRequestAction, requestNotForProjectAction, requestPlacementContextAction, undoRequestPlacementAction,
} from "@/app/jobs/requestActions";
import { confirmAskAction, reopenAskAction } from "@/app/ops/requests/actions";

// ---------------------------------------------------------------------------
// THE REQUEST BUTTONS (Kyle, Oct 28 2026; lib/requestPlacement). Reusable on
// any screen that shows a client request:
//   · <NotForThisProject askId>: "Not for this project" opens three choices
//     (move to another of the client's open projects, keep for a future
//     project, not a request), each with Undo. It needs only the request's id:
//     where it can go is read when the panel opens, so a delivery checklist,
//     the Review Room or a desk row can drop it in as it is.
//   · <RequestQuickActions askId>: Checked for this one request (with Undo)
//     beside Not for this project, for lists (the Projects list).
//   · <UndoPlacementButton askId>: the Undo on a "taken off this project" row.
//   · <SavedRequestList>: requests kept for a future project, each put on a
//     project or set aside.
//   · <PlacementUndoHost />: a list page's one Undo bar (below).
// `refresh`: true (the project page) re-reads the page after a press, where
// the "Taken off this project" row keeps the Undo; false (lists) does not
// ask for a re-read itself.
//
// THE UNDO THAT OUTLIVES ITS ROW. Every press is a server action that
// revalidates, and Next re-renders the page it was pressed on at once: a
// request moved, kept, set aside or checked leaves the list, and an Undo
// inside its row would leave with it. A list page (the Projects list, the
// checklist, the desk, the client page) mounts one <PlacementUndoHost />
// outside its rows; a press hands it the result and its Undo (ui/Toast's
// NoticeHost, with a button). With no host on the page the row keeps its own.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const FAILED: Result = { ok: false, message: "That didn't go through. Reload the page and try again." };
const BTN = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:min-h-9";
const QUIET = `${BTN} border border-border text-foreground hover:bg-surface-2`;
const LINK = "inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand hover:underline disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:min-h-9";

type Context = { fromProjectId: string; street: string; clientName: string | null; choices: { id: string; label: string }[] };

function Status({ r }: { r: Result }) {
  return (
    <span role={r.ok ? "status" : "alert"} className={`text-[13px] ${r.ok ? "text-success" : "text-danger"}`}>
      {r.message}
    </span>
  );
}

type Undoable = { message: string; undo: () => Promise<Result> };
const hosts: ((u: Undoable) => void)[] = [];
/** Hand a press's answer and its Undo to the page's host. False when the page has none (the row keeps its own Undo). */
export function handToUndoHost(u: Undoable): boolean {
  const host = hosts[0]; // two on one page (the checklist beside the desk): the first shows it
  if (!host) return false;
  host(u);
  return true;
}

export function PlacementUndoHost() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [cur, setCur] = useState<(Undoable & { n: number; done?: Result }) | null>(null);
  useEffect(() => {
    const host = (u: Undoable) => setCur((c) => ({ ...u, n: (c?.n ?? 0) + 1 }));
    hosts.push(host);
    return () => {
      const i = hosts.indexOf(host);
      if (i >= 0) hosts.splice(i, 1);
    };
  }, []);
  // Gone after 20 seconds; the Undo's own answer after 6.
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => setCur(null), cur.done ? 6_000 : 20_000);
    return () => clearTimeout(t);
  }, [cur]);
  const undo = () =>
    start(async () => {
      if (!cur) return;
      const r = await cur.undo().catch(() => FAILED);
      setCur((c) => (c ? { ...c, done: r } : c));
      if (r.ok) router.refresh();
    });
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[1400] flex justify-center px-4 sm:bottom-6" data-placement-undo-host>
      {cur && (
        <div key={cur.n} role={cur.done && !cur.done.ok ? "alert" : "status"} className={`pointer-events-auto flex w-full max-w-md flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-4 py-1.5 text-sm font-medium shadow-lg ring-1 ${cur.done && !cur.done.ok ? "bg-danger-action text-white ring-danger/30" : "bg-foreground text-background ring-border-strong"}`}>
          <span className="min-w-0 flex-1 py-1.5 [overflow-wrap:anywhere]">{cur.done?.message ?? cur.message}</span>
          {!cur.done && (
            <button type="button" disabled={busy} onClick={undo} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 font-semibold underline-offset-2 hover:underline disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 sm:min-h-9" data-host-undo>
              {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Undo2 aria-hidden className="size-4" />} Undo
            </button>
          )}
          <button type="button" onClick={() => setCur(null)} aria-label="Dismiss" className="-mr-2 inline-flex size-11 items-center justify-center rounded-lg opacity-80 hover:opacity-100 sm:size-9">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export function NotForThisProject({
  askId,
  refresh = true,
  context,
  onChange,
}: {
  askId: string;
  refresh?: boolean;
  /** Where it can go, when the page already read it (else read when the panel opens). */
  context?: Context | null;
  /** Told when a press took the request off (true) or Undo put it back (false). */
  onChange?: (off: boolean) => void;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Context | null>(context ?? null);
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState<Result | null>(null);
  const [off, setOff] = useState(false);
  const [handed, setHanded] = useState(false);

  const openPanel = () => {
    setOpen(true);
    setMsg(null);
    if (ctx) return;
    start(async () => {
      const r = await requestPlacementContextAction(askId).catch(() => FAILED);
      if ("fromProjectId" in r) setCtx({ fromProjectId: r.fromProjectId, street: r.street, clientName: r.clientName, choices: r.choices });
      else setMsg(r);
    });
  };
  const press = (outcome: "move" | "future" | "dismiss") =>
    start(async () => {
      if (!ctx) return;
      const r = await requestNotForProjectAction({ askId, fromProjectId: ctx.fromProjectId, outcome, toProjectId: outcome === "move" ? target : null }).catch(() => FAILED);
      setMsg(r);
      if (!r.ok) return;
      setHanded(handToUndoHost({ message: r.message, undo: () => undoRequestPlacementAction(askId) }));
      setOpen(false);
      setOff(true);
      onChange?.(true);
      if (refresh) router.refresh();
    });
  const undo = () =>
    start(async () => {
      const r = await undoRequestPlacementAction(askId).catch(() => FAILED);
      setMsg(r);
      if (!r.ok) return;
      setOff(false);
      onChange?.(false);
      router.refresh();
    });

  if (off) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-not-for-project-done={askId}>
        {msg && <Status r={msg} />}
        {!handed && (
          <button type="button" disabled={busy} onClick={undo} className={LINK} data-placement-undo>
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Undo2 aria-hidden className="size-4" />} Undo
          </button>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" onClick={openPanel} className={QUIET} data-not-for-project={askId} aria-expanded={false}>
          <ArrowRightLeft aria-hidden className="size-4" /> Not for this project
        </button>
        {msg && <Status r={msg} />}
      </div>
    );
  }

  const who = ctx?.clientName ?? "the client";
  const selectId = `move-${askId}`;
  return (
    <div role="group" aria-label="Not for this project" data-not-for-project-panel={askId} className="w-full min-w-0 space-y-2.5 rounded-lg border border-border bg-surface p-3">
      {(ctx || !msg) && <p className="text-sm font-medium text-foreground">Not for {ctx?.street ?? "this project"}. Where does it belong?</p>}
      {!ctx && !msg && (
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> Reading the client&rsquo;s projects
        </p>
      )}
      {ctx && (
        <>
          <div className="space-y-1.5" data-choice="move">
            <label htmlFor={selectId} className="block text-[13px] text-muted">Move it to another project</label>
            {ctx.choices.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <select id={selectId} value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} className="min-h-11 w-full min-w-0 max-w-full rounded-lg border border-border bg-surface-2 px-2 text-sm sm:min-h-9 sm:w-auto">
                  <option value="">Pick {who}&rsquo;s project</option>
                  {ctx.choices.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
                <button type="button" disabled={busy || !target} onClick={() => press("move")} className={`${BTN} bg-brand-action font-semibold text-brand-fg hover:brightness-95`}>
                  {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <ArrowRightLeft aria-hidden className="size-4" />} Move
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted">No other open project for {who}.</p>
            )}
          </div>
          <div className="space-y-1" data-choice="future">
            <button type="button" disabled={busy} onClick={() => press("future")} className={QUIET}>
              <CalendarClock aria-hidden className="size-4" /> Keep for a future project
            </button>
            <p className="text-[12px] text-muted">It stays on {who}&rsquo;s client page and is offered on their next project.</p>
          </div>
          <div data-choice="dismiss">
            <button type="button" disabled={busy} onClick={() => press("dismiss")} className={QUIET}>
              <X aria-hidden className="size-4" /> Not a request
            </button>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setMsg(null); }} className={`${BTN} text-muted hover:text-foreground`}>
          Cancel
        </button>
        {msg && <Status r={msg} />}
      </div>
    </div>
  );
}

/** Checked for one request, with Undo, beside Not for this project (the Projects list). */
export function RequestQuickActions({ askId, refresh = false }: { askId: string; refresh?: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [checked, setChecked] = useState<Result | null>(null);
  const [handed, setHanded] = useState(false);
  const [off, setOff] = useState(false);
  const [err, setErr] = useState<Result | null>(null);
  const check = () =>
    start(async () => {
      const r = await confirmAskAction(askId).catch(() => FAILED);
      if (!r.ok) return setErr(r);
      setErr(null);
      setChecked(r);
      setHanded(handToUndoHost({ message: "Checked.", undo: () => reopenAskAction(askId) }));
      if (refresh) router.refresh();
    });
  const uncheck = () =>
    start(async () => {
      const r = await reopenAskAction(askId).catch(() => FAILED);
      if (!r.ok) return setErr(r);
      setErr(null);
      setChecked(null);
      router.refresh();
    });
  if (checked) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-request-checked={askId}>
        <Status r={{ ok: true, message: "Checked." }} />
        {!handed && (
          <button type="button" disabled={busy} onClick={uncheck} className={LINK}>
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <RotateCcw aria-hidden className="size-4" />} Undo
          </button>
        )}
        {err && <Status r={err} />}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2" data-request-actions={askId}>
      {!off && (
        <button type="button" disabled={busy} onClick={check} className={`${BTN} bg-brand-action font-semibold text-brand-fg hover:brightness-95`} data-request-check>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <CheckCheck aria-hidden className="size-4" />} Checked
        </button>
      )}
      <NotForThisProject askId={askId} refresh={refresh} onChange={setOff} />
      {err && <Status r={err} />}
    </div>
  );
}

/** Undo on a "taken off this project" row. */
export function UndoPlacementButton({ askId }: { askId: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<Result | null>(null);
  if (msg?.ok) return <Status r={msg} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await undoRequestPlacementAction(askId).catch(() => FAILED);
            setMsg(r);
            if (r.ok) router.refresh();
          })
        }
        className={LINK}
        data-placement-undo={askId}
      >
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Undo2 aria-hidden className="size-4" />} Undo
      </button>
      {msg && <Status r={msg} />}
    </span>
  );
}

export type SavedRequestItem = { askId: string; summary: string; text: string; askedBy: string | null; from: string; askedWords: string; keptLine: string };

/**
 * Requests kept for a future project. On a project page (`projectId`): "Put on
 * this project" or "Not needed". On the client page (`choices`): pick one of
 * the client's open projects. Each press has its Undo.
 */
export function SavedRequestList({ items, projectId, street, choices, canAct }: { items: SavedRequestItem[]; projectId?: string; street?: string; choices?: { id: string; label: string }[]; canAct: boolean }) {
  return (
    <ul className="space-y-2" data-saved-requests>
      {items.map((it) => (
        <SavedRequestRow key={it.askId} it={it} projectId={projectId} street={street} choices={choices} canAct={canAct} />
      ))}
    </ul>
  );
}

function SavedRequestRow({ it, projectId, street, choices, canAct }: { it: SavedRequestItem; projectId?: string; street?: string; choices?: { id: string; label: string }[]; canAct: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [target, setTarget] = useState(projectId ?? "");
  const [done, setDone] = useState<Result | null>(null);
  const [handed, setHanded] = useState(false);
  const [err, setErr] = useState<Result | null>(null);
  // Put on THIS project (its page): re-read the page so the request shows on
  // its card at once, where its own "Not for this project" can take it off
  // again. Anywhere else the row stays, with its Undo.
  const run = (fn: () => Promise<Result>, reread = false) =>
    start(async () => {
      const r = await fn().catch(() => FAILED);
      if (!r.ok) return setErr(r);
      setErr(null);
      setDone(r);
      setHanded(handToUndoHost({ message: r.message, undo: () => undoRequestPlacementAction(it.askId) }));
      if (reread) router.refresh();
    });
  const undo = () =>
    start(async () => {
      const r = await undoRequestPlacementAction(it.askId).catch(() => FAILED);
      if (!r.ok) return setErr(r);
      setErr(null);
      setDone(null);
      router.refresh();
    });
  const selectId = `saved-${it.askId}`;
  return (
    <li className="min-w-0 space-y-1.5 rounded-lg bg-surface-2 px-3 py-2" data-saved-request={it.askId}>
      <p className="text-sm text-foreground [overflow-wrap:anywhere]">{it.summary}</p>
      <p className="text-xs text-muted [overflow-wrap:anywhere]">
        {it.askedBy ?? "The client"} · {it.from} · {it.askedWords} · {it.keptLine}
      </p>
      {it.text.trim() && it.text.trim() !== it.summary.trim() && (
        <details className="text-xs">
          <summary className="cursor-pointer py-1 font-medium text-brand">The client&rsquo;s words</summary>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-surface px-2 py-1.5 text-[13px] text-foreground/85 [overflow-wrap:anywhere]">{it.text}</p>
        </details>
      )}
      {canAct && (done ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Status r={done} />
          {!handed && (
            <button type="button" disabled={busy} onClick={undo} className={LINK} data-placement-undo>
              {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Undo2 aria-hidden className="size-4" />} Undo
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {projectId ? (
            <button type="button" disabled={busy} onClick={() => run(() => placeSavedRequestAction(it.askId, projectId), true)} className={`${BTN} bg-brand-action font-semibold text-brand-fg hover:brightness-95`} data-saved-place>
              {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <CheckCheck aria-hidden className="size-4" />} Put on {street ?? "this project"}
            </button>
          ) : choices && choices.length ? (
            <>
              <label htmlFor={selectId} className="sr-only">Which project is it for?</label>
              <select id={selectId} value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} className="min-h-11 w-full min-w-0 max-w-full rounded-lg border border-border bg-surface px-2 text-sm sm:min-h-9 sm:w-auto">
                <option value="">Which project is it for?</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              <button type="button" disabled={busy || !target} onClick={() => run(() => placeSavedRequestAction(it.askId, target))} className={`${BTN} bg-brand-action font-semibold text-brand-fg hover:brightness-95`} data-saved-place>
                Put it on this project
              </button>
            </>
          ) : (
            <span className="text-[13px] text-muted">No open project yet. It is offered on the next one booked.</span>
          )}
          <button type="button" disabled={busy} onClick={() => run(() => dismissSavedRequestAction(it.askId))} className={QUIET} data-saved-dismiss>
            <X aria-hidden className="size-4" /> Not needed
          </button>
        </div>
      ))}
      {err && <Status r={err} />}
    </li>
  );
}
