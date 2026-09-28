"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileQuestion, Loader2, Paperclip } from "lucide-react";
import { attachAssetReferenceAction, recordAssetDependencyAction } from "@/app/editing/actions";

// ---------------------------------------------------------------------------
// WAITING ON A FILE (§10 J3, Sep 28 2026) — the office's two presses on the
// job page, for the rare job whose work cannot start without something only
// the client or a record can supply: the recorded plat or survey before lot
// lines go on an aerial, the client's logo for an intro card.
//
// The rules are lib/assetDependencies' and the server actions', not this
// card's: finding the file is Kyle's; reading or drawing from it is a named
// person's (Jordan by default); attaching closes the FINDING only; nothing
// reaches the client. This card only records and attaches, and says back
// exactly what the server said.
//
// Office only, never a "view as" preview (the page does not mount it; both
// actions refuse anyone else anyway). Editors read the same sentences in the
// job's brief, not here. Quiet on purpose: with nothing open it is one folded
// line, because it is used a few times a month at most.
//
// Client-safe: imports the two server actions and lucide, nothing else.
// ---------------------------------------------------------------------------

/** One open dependency as the page hands it over (lib openAssetDependencies, with its video named). */
export type AssetDependencyRow = {
  taskId: string;
  stage: "retrieval" | "interpretation";
  /** the brief's own sentence: "Waiting on … (Kyle to find it)", or who works from the file */
  sentence: string;
  /** which video, in words — "Video 2: Standard Reel" — or "The whole job" */
  scope: string;
};

/**
 * The dependency's id, from the words typed: lowercase, hyphens for anything
 * else, at most 61 characters, never starting or ending on a hyphen — which is
 * exactly what the server's slugOk accepts. The same words on the same video
 * are the same id, so a second press is "Already recorded", not a second pair.
 * Empty when there is nothing to make an id from (the card asks for words).
 */
export function assetSlugFor(need: string): string {
  return need
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 61)
    .replace(/-+$/, "");
}

const input =
  "w-full rounded-lg border bg-surface px-2 py-1.5 text-xs font-normal text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30";

export function AssetDependencyCard({
  projectId,
  open,
  videos,
  people,
  readFailed = false,
}: {
  projectId: string;
  open: AssetDependencyRow[];
  /** the job's owed videos (DeliverableOutput), for "which video" */
  videos: { outputId: string; label: string }[];
  /** who may work from the file (lib INTERPRETER_KEYS), Jordan first */
  people: { key: string; name: string }[];
  /** the page could not read the open ones — said, never shown as "none" */
  readFailed?: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [need, setNeed] = useState("");
  const [outputId, setOutputId] = useState("");
  const [interpret, setInterpret] = useState(false);
  const [what, setWhat] = useState("");
  const [who, setWho] = useState(people[0]?.key ?? "jordan");
  const [refs, setRefs] = useState<Record<string, string>>({});

  const record = () =>
    start(async () => {
      const words = need.trim();
      const slug = assetSlugFor(words);
      if (!slug) return setMsg({ ok: false, text: "Say what file is missing, in words." });
      if (interpret && !what.trim()) return setMsg({ ok: false, text: "Say what they do with the file, or untick the box." });
      const r = await recordAssetDependencyAction({
        projectId,
        outputId: outputId || null,
        slug,
        need: words,
        interpretation: interpret ? { what: what.trim(), ownerKey: who } : null,
      }).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        setNeed("");
        setWhat("");
        setInterpret(false);
        setOutputId("");
        router.refresh();
      }
    });

  const attach = (taskId: string) =>
    start(async () => {
      const ref = (refs[taskId] ?? "").trim();
      if (!ref) return setMsg({ ok: false, text: "Paste the Dropbox link or the file's path first." });
      const r = await attachAssetReferenceAction(taskId, ref).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        setRefs((m) => ({ ...m, [taskId]: "" }));
        router.refresh();
      }
    });

  const form = (
    <div className="mt-2 space-y-2">
      <label className="block text-[11px] font-medium text-muted">
        What is missing
        <input
          value={need}
          onChange={(e) => setNeed(e.target.value)}
          maxLength={160}
          placeholder="the recorded plat or survey for the lot lines"
          className={`mt-0.5 ${input}`}
        />
      </label>
      <label className="block text-[11px] font-medium text-muted">
        Which video
        <select value={outputId} onChange={(e) => setOutputId(e.target.value)} className={`mt-0.5 ${input}`}>
          <option value="">The whole job</option>
          {videos.map((v) => (
            <option key={v.outputId} value={v.outputId}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[11px] font-medium text-muted">
        <input type="checkbox" checked={interpret} onChange={(e) => setInterpret(e.target.checked)} />
        Someone must work from it once it is in
      </label>
      {interpret && (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="block text-[11px] font-medium text-muted sm:col-span-2">
            What they do with it
            <input
              value={what}
              onChange={(e) => setWhat(e.target.value)}
              maxLength={160}
              placeholder="Draw the lot lines from the attached plat"
              className={`mt-0.5 ${input}`}
            />
          </label>
          <label className="block text-[11px] font-medium text-muted">
            Who
            <select value={who} onChange={(e) => setWho(e.target.value)} className={`mt-0.5 ${input}`}>
              {people.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <button
        type="button"
        disabled={busy || !need.trim()}
        onClick={record}
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand-soft/40 disabled:opacity-40"
      >
        {busy && <Loader2 className="size-3.5 animate-spin" />} Record it
      </button>
      <p className="text-[11px] text-muted-2">Kyle gets a task to find it. Nothing is sent to the client.</p>
    </div>
  );

  const note = msg && (
    <p className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${msg.ok ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`} role="status">
      {msg.text}
    </p>
  );

  // Nothing waiting: one folded line, out of the way.
  if (open.length === 0 && !readFailed) {
    return (
      <details className="rounded-xl border border-border bg-surface px-4 py-2.5 text-xs text-muted" data-asset-deps="none">
        <summary className="cursor-pointer">Waiting on a file? A plat or survey, the client&rsquo;s logo…</summary>
        {note && <div className="mt-2">{note}</div>}
        {form}
      </details>
    );
  }

  return (
    <section className="rounded-xl border border-warning/30 bg-warning-soft/30 p-3 text-xs" data-asset-deps={open.length}>
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <FileQuestion className="size-4 text-warning" /> Waiting on a file
      </p>
      {readFailed && <p className="mt-1 text-muted">Couldn&rsquo;t read what this job is waiting on. Refresh to try again.</p>}
      {open.length > 0 && (
        <ul className="mt-2 space-y-2">
          {open.map((d) => (
            <li key={d.taskId} className="rounded-lg border border-border bg-surface px-3 py-2" data-asset-dep={d.stage}>
              <p className="text-foreground/90">{d.sentence}</p>
              <p className="text-[11px] text-muted">{d.scope}</p>
              {d.stage === "retrieval" && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <input
                    value={refs[d.taskId] ?? ""}
                    onChange={(e) => setRefs((m) => ({ ...m, [d.taskId]: e.target.value }))}
                    maxLength={500}
                    placeholder="Dropbox link or file path"
                    aria-label="Dropbox link or file path"
                    className={`min-w-0 flex-1 basis-48 ${input}`}
                  />
                  <button
                    type="button"
                    disabled={busy || !(refs[d.taskId] ?? "").trim()}
                    onClick={() => attach(d.taskId)}
                    className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
                  >
                    <Paperclip className="size-3" /> Attach the file
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && <div className="mt-2">{note}</div>}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] font-medium text-brand">Record another file this job is waiting on</summary>
        {form}
      </details>
    </section>
  );
}
