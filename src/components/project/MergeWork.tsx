"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GitMerge, Undo2 } from "lucide-react";
import { mergeCandidates, mergePreview, mergeProjectWork, unmergeProjectWork } from "@/app/editing/actions";

// ---------------------------------------------------------------------------
// Merging one job's WORK into another (lib/projectMerge has the why). Three
// states on one card, because they are three answers to the same question —
// where does this job's work live?
//
//   · this job's work went somewhere  → say where, offer to undo
//   · work came in from another job   → say which, offer to undo
//   · neither                         → offer to move it
//
// The copy leads with what does NOT move, because that is the thing a person
// is afraid of when they press a button called merge.
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric", year: "numeric" }) : "no shoot date";

type Candidate = Awaited<ReturnType<typeof mergeCandidates>>[number];

export function MergeWork({
  projectId,
  street,
  mergedAway,
  mergedIn,
}: {
  projectId: string;
  street: string;
  /** this job's work has moved to another job */
  mergedAway: { intoId: string; intoStreet: string; by: string | null; atISO: string; note: string | null } | null;
  /** other jobs whose work now lives here */
  mergedIn: { fromId: string; fromStreet: string; atISO: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [pick, setPick] = useState("");
  const [why, setWhy] = useState("");
  const [preview, setPreview] = useState<{ deliverables: number; cuts: number; cards: number; videos: number } | null>(null);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || rows) return;
    mergeCandidates(projectId).then(setRows).catch(() => setRows([]));
    mergePreview(projectId).then(setPreview).catch(() => setPreview(null));
  }, [open, rows, projectId]);

  const undo = (id: string) =>
    start(async () => {
      const r = await unmergeProjectWork(id).catch(() => ({ ok: false, message: "Couldn’t do that — try again." }));
      setMsg(r.message);
      router.refresh();
    });

  // ---- this job's work lives elsewhere -----------------------------------
  if (mergedAway) {
    return (
      <div className="rounded-xl border border-brand/30 bg-brand-soft/30 p-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <GitMerge className="size-4 text-brand" /> This job&rsquo;s work is on another job
        </p>
        <p className="mt-1 text-xs leading-relaxed text-foreground/85">
          Everything it owed — the deliverables, the cuts and the edit cards — was moved to{" "}
          <Link href={`/projects/${mergedAway.intoId}`} className="font-medium text-brand hover:underline">
            {mergedAway.intoStreet}
          </Link>
          . This job keeps its own order, its invoice, its shoot and its appointment; only the work moved.
        </p>
        <p className="mt-1 text-[11px] text-muted-2">
          {mergedAway.by ?? "The office"} · {day(mergedAway.atISO)}
          {mergedAway.note ? ` — “${mergedAway.note}”` : ""}
        </p>
        {msg && <p className="mt-1.5 text-xs text-foreground/85">{msg}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => undo(projectId)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 disabled:opacity-60"
        >
          <Undo2 className="size-3.5" /> Bring the work back here
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {mergedIn.length > 0 && (
        <div className="rounded-xl border border-border bg-surface-2/50 p-3">
          <p className="text-sm font-semibold">Work merged in</p>
          <ul className="mt-1 space-y-1">
            {mergedIn.map((m) => (
              <li key={m.fromId} className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                <Link href={`/projects/${m.fromId}`} className="font-medium text-brand hover:underline">{m.fromStreet}</Link>
                <span className="text-muted-2">· {day(m.atISO)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => undo(m.fromId)}
                  className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface disabled:opacity-60"
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <GitMerge className="size-3.5" /> Merge this job&rsquo;s work into another
        </button>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-3">
          <p className="text-sm font-semibold">Move {street}&rsquo;s work to another job</p>
          <p className="mt-1 text-xs leading-relaxed text-foreground/85">
            For a second shoot on the same listing. The deliverables, cuts and edit cards move; the
            order, the invoice, the shoot and the appointment stay here, and this job stays in the
            client&rsquo;s history. Both orders remain billed.
          </p>
          {preview && (
            <p className="mt-1.5 text-[11px] text-muted-2">
              Moving: {preview.deliverables} deliverable{preview.deliverables === 1 ? "" : "s"}
              {preview.videos > 0 && ` (${preview.videos} video)`}
              {preview.cuts > 0 && ` · ${preview.cuts} cut${preview.cuts === 1 ? "" : "s"}`}
              {preview.cards > 0 && ` · ${preview.cards} edit card${preview.cards === 1 ? "" : "s"}`}
            </p>
          )}
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            disabled={rows === null}
            className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-brand disabled:opacity-50"
          >
            <option value="">{rows === null ? "Loading this client’s other jobs…" : rows.length ? "Pick the job it belongs to" : "This client has no other job"}</option>
            {(rows ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.street} — {r.status.toLowerCase()}
                {r.shootISO ? `, shot ${day(r.shootISO)}` : ", no shoot date"}
                {r.owes > 0 ? ` · owes ${r.owes}` : ""}
              </option>
            ))}
          </select>
          <input
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="Why? (optional — it goes on both timelines)"
            className="mt-2 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand"
          />
          {msg && <p className="mt-1.5 text-xs text-foreground/85">{msg}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !pick}
              onClick={() =>
                start(async () => {
                  const r = await mergeProjectWork(projectId, pick, why.trim() || undefined).catch(() => ({
                    ok: false,
                    message: "Couldn’t do that — try again.",
                  }));
                  setMsg(r.message);
                  if (r.ok) { setOpen(false); setPick(""); setWhy(""); }
                  router.refresh();
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              <GitMerge className="size-3.5" /> {busy ? "Moving" : "Move the work"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setOpen(false); setMsg(null); }}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
