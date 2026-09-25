"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { CAUSE_LABEL, ISSUE_CAUSES } from "@/lib/issueCauses";
import { classifyIssueAction } from "@/app/review/issueActions";
import { saveSelfCheckProfile } from "@/app/review/selfCheckActions";
import type { SelfCheckItem, SelfCheckProfile } from "@/lib/selfCheck";

// ---------------------------------------------------------------------------
// The reviewer's two standing jobs on the Editor quality tab (§8.3 / §8.2):
//   · CLASSIFY — issues nobody has given a cause yet, newest first. Until a
//     person says why, an issue counts for nobody (the first-review rate
//     reports it as "waiting on a cause", not as a fail).
//   · REFINE THE CHECKLIST — per product, as a new version; checks already
//     given keep the list they were answered under.
// ---------------------------------------------------------------------------

export type UnclassifiedRow = { id: string; projectId: string; street: string; text: string; category: string; raisedByName: string | null; versionEditorKey: string | null; causeSuggested: string | null; createdAtISO: string };

export function UnclassifiedIssues({ rows }: { rows: UnclassifiedRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Record<string, string>>({});
  if (rows.length === 0) return <p className="text-sm text-muted">Every issue has a cause.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="rounded-xl border border-border bg-surface p-3">
          <p className="text-sm leading-snug">{r.text}</p>
          <p className="mt-0.5 text-[11px] text-muted-2">
            <Link href={`/edit/${r.projectId}#issues`} className="text-brand hover:underline">{r.street}</Link> · {r.category}
            {r.raisedByName ? ` · from ${r.raisedByName}` : ""}
            {r.versionEditorKey ? ` · version by ${r.versionEditorKey}` : ""}
            {r.causeSuggested ? ` · suggested: ${CAUSE_LABEL[r.causeSuggested as keyof typeof CAUSE_LABEL] ?? r.causeSuggested}` : ""}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <select
              aria-label="Cause"
              disabled={pending}
              defaultValue="UNCLASSIFIED"
              onChange={(e) =>
                start(async () => {
                  const res = await classifyIssueAction(r.id, { cause: e.target.value });
                  setMsg((m) => ({ ...m, [r.id]: res.message }));
                  if (res.ok) router.refresh();
                })
              }
              className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs"
            >
              {ISSUE_CAUSES.map((c) => <option key={c} value={c}>{CAUSE_LABEL[c]}</option>)}
            </select>
            {pending && <Loader2 className="size-3.5 animate-spin text-muted" />}
            {msg[r.id] && <span className="text-[11px] text-muted">{msg[r.id]}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SelfCheckSettings({ profiles }: { profiles: SelfCheckProfile[] }) {
  const [which, setWhich] = useState(profiles[0]?.styleKey ?? "");
  const current = profiles.find((p) => p.styleKey === which) ?? profiles[0];
  const [items, setItems] = useState<Record<string, SelfCheckItem[]>>(() => Object.fromEntries(profiles.map((p) => [p.styleKey, p.items])));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (!current) return null;
  const list = items[current.styleKey] ?? current.items;
  const edit = (i: number, patch: Partial<SelfCheckItem>) => setItems((s) => ({ ...s, [current.styleKey]: list.map((it, n) => (n === i ? { ...it, ...patch } : it)) }));
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={current.styleKey} onChange={(e) => { setWhich(e.target.value); setMsg(null); }} className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm">
          {profiles.map((p) => <option key={p.styleKey} value={p.styleKey}>{p.styleName}</option>)}
        </select>
        <span className="text-xs text-muted">in force: {current.checklistKey}</span>
      </div>
      <ul className="mt-3 space-y-2">
        {list.map((it, i) => (
          <li key={`${it.key}-${i}`} className="rounded-xl border border-border p-2.5">
            <input value={it.label} onChange={(e) => edit(i, { label: e.target.value })} className="w-full rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm" />
            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted">
              <label className="inline-flex items-center gap-1"><input type="checkbox" checked={it.naAllowed} disabled={it.key === "watched_full"} onChange={(e) => edit(i, { naAllowed: e.target.checked })} /> may be Not applicable (with a reason)</label>
              <label className="inline-flex items-center gap-1"><input type="checkbox" checked={it.when === "revision"} onChange={(e) => edit(i, { when: e.target.checked ? "revision" : "always" })} /> only on revisions</label>
              {it.key !== "watched_full" && (
                <button type="button" onClick={() => setItems((s) => ({ ...s, [current.styleKey]: list.filter((_, n) => n !== i) }))} className="inline-flex items-center gap-1 text-danger hover:underline">
                  <Trash2 className="size-3" /> remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setItems((s) => ({ ...s, [current.styleKey]: [...list, { key: `custom_${Date.now().toString(36)}`, label: "", naAllowed: false, when: "always" }] }))}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-surface-2"
        >
          <Plus className="size-3" /> Add a line
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => { const r = await saveSelfCheckProfile(current.styleKey, list); setMsg(r.message); })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
        >
          {pending && <Loader2 className="size-3 animate-spin" />} Save as a new version
        </button>
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </div>
  );
}
