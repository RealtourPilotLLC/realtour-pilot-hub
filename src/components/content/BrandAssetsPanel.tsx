"use client";

import { useState, useTransition } from "react";
import { BellRing, FolderOpen, History, Image as ImageIcon, Info, Palette, Plus, Quote, Sparkles } from "lucide-react";
import { Section } from "@/components/ui/Section";
import {
  createAssetAction, addAssetVersionAction, setActiveAssetVersionAction, retireAssetAction,
  updateAssetMetaAction, registerFolderFileAction,
} from "@/app/content/[id]/workspaceActions";

// ---------------------------------------------------------------------------
// BRAND & ASSETS (spec §17). What a video of this client is allowed to look
// and sound like: colours, logos, branding cards, fonts and references,
// headshots, approved photos, example videos, name pronunciation, contact
// details, production preferences and the persistent editing instructions.
//
// The idea the screen is built around: an asset has VERSIONS. Replacing a logo
// records a new version that becomes the default for future work — it does not
// rewrite what a delivered video used, and the old file stays where it is. The
// version list under each asset is the proof of that.
//
// Underneath, three SOURCES are shown as sources, never silently merged into
// the registry: the Client columns (brand colours, assets path, avatar), the
// six AgentProfile blobs, and the client's Dropbox folder. A file in the
// folder can be promoted into a tracked asset in one click; until somebody
// does, it is listed as "in the folder, not tracked".
//
// CP-06 (Sep 24 2026): the client's own Brand Profile slots (fonts, website,
// social, music) are tracked assets too, marked "client profile"; a CLEARED
// version reads as cleared, not blank; and "Brand changes" shows every change,
// who made it, whether the editor was told and whether they have it. Every
// edit here is recorded the same way (workspaceActions → recordStaffAssetChange).
// ---------------------------------------------------------------------------

export type AssetVersionUi = { id: string; versionNo: number; source: string; fileName: string | null; valueText: string | null; note: string | null; uploadedBy: string | null; createdAtISO: string; url: string | null; cleared?: boolean };
export type AssetUi = { id: string; type: string; typeWord: string; name: string; ownership: string; status: string; notes: string | null; isText: boolean; profileKey?: string | null; active: AssetVersionUi | null; versions: AssetVersionUi[] };
/** One brand change (ClientBrandChange) and what became of its alert. */
export type BrandChangeUi = {
  id: string; label: string; kind: string; fromText: string | null; toText: string | null; source: string; actorLabel: string | null; createdAtISO: string;
  alertChannel: string | null; alertEditorKeys: string | null; ackAtISO: string | null; ackBy: string | null;
};
export type SourcesUi = {
  client: { brandColors: string | null; brandAssetsPath: string | null; avatarUrl: string | null; portalVideoStyle: string | null; portalPreferences: string | null; generalNotes: string | null };
  profile: Record<string, Record<string, string>>;
  folder: { path: string; folderUrl: string | null; folderExists: boolean; files: { name: string; path: string; url: string | null; tracked: boolean }[] } | null;
};
/** Accepted, AI-allowed client facts that also feed the editor brief — shown here with where each came from. */
export type ProvenanceUi = { id: string; body: string; category: string; scope: string; source: string; projectId: string | null; monthId: string | null; factDateISO: string | null }[];

const btn = "rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50";
const quiet = "rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50";
const input = "rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm";
const day = (isoStr: string) => new Date(isoStr).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });

const TEXT_TYPES = new Set(["COLOR_PALETTE", "PRONUNCIATION", "CONTACT_CARD", "EDITING_INSTRUCTIONS", "PRODUCTION_PREFERENCE", "FONT", "EXAMPLE_VIDEO", "WEBSITE", "SOCIAL_LINKS", "MUSIC_PREFERENCE"]);
const ALERT_WORDS: Record<string, string> = {
  slack: "editor messaged on Slack", sms: "editor texted", bell: "editor's bell only", deduped: "covered by this hour's message",
  pending: "editor not messaged (alerts off) — on their brief", sending: "sending…", none: "editor not reachable", no_editor: "no editor on their work",
  skipped_test: "test client — nobody told",
};

export function BrandAssetsPanel({
  enrollmentId, clientId, assets, types, sources, provenance, canEdit, changes = [],
}: {
  enrollmentId: string; clientId: string; assets: AssetUi[]; types: { key: string; word: string }[];
  sources: SourcesUi; provenance: ProvenanceUi; canEdit: boolean; changes?: BrandChangeUi[];
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const say = (r: { ok: boolean; message: string }) => setNote(`${r.ok ? "" : "Couldn't do that — "}${r.message}`);
  const grouped = types.map((t) => ({ ...t, rows: assets.filter((a) => a.type === t.key) })).filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-5">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">{note}</p>}

      <Section
        icon={Palette}
        title="Tracked assets"
        count={assets.length}
        flush
        action={<span className="hidden text-[11px] text-muted-2 sm:inline">a replacement is a new version — delivered work keeps what it was made with</span>}
      >
        <div className="divide-y divide-border">
          {assets.length === 0 && (
            <p className="px-5 py-4 text-sm text-muted">
              Nothing is tracked yet. The sources below are still in use — this list is how a brand fact becomes something with an owner, a version and a date.
            </p>
          )}
          {grouped.map((g) => (
            <div key={g.key} className="px-5 py-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">{g.word}</p>
              <div className="space-y-2">
                {g.rows.map((a) => <AssetRow key={a.id} a={a} enrollmentId={enrollmentId} canEdit={canEdit} busy={busy} start={start} say={say} />)}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {canEdit && <NewAsset enrollmentId={enrollmentId} clientId={clientId} types={types} busy={busy} start={start} say={say} />}

      {/* ---- CP-06: every brand change, and whether the editor has it ---- */}
      {changes.length > 0 && (
        <Section icon={BellRing} title="Brand changes" count={changes.length} flush action={<span className="hidden text-[11px] text-muted-2 sm:inline">the editor sees unacknowledged ones as a banner on the brief</span>}>
          <div className="divide-y divide-border">
            {changes.map((c) => (
              <div key={c.id} className="px-5 py-2 text-[13px]">
                <p>
                  <span className="font-medium">{c.label}</span>{" "}
                  {c.kind === "FILE_ADDED" ? `— new file ${c.toText ?? ""}` : c.kind === "FILE_REPLACED" ? `— replaced${c.fromText ? ` ${c.fromText}` : ""} → ${c.toText ?? ""}` : c.toText ? `— ${c.fromText ? `“${c.fromText.slice(0, 80)}” → ` : ""}“${c.toText.slice(0, 120)}”` : `— cleared${c.fromText ? ` (was “${c.fromText.slice(0, 80)}”)` : ""}`}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-2">
                  <span>{day(c.createdAtISO)} · {c.source === "client_portal" ? "client portal" : c.source === "fact" ? "applied from a call" : "staff"}{c.actorLabel ? ` · ${c.actorLabel}` : ""}</span>
                  <span className="rounded-full bg-surface-2 px-1.5 py-0.5">{c.alertChannel ? ALERT_WORDS[c.alertChannel] ?? c.alertChannel : "alert pending"}{c.alertEditorKeys ? ` (${c.alertEditorKeys})` : ""}</span>
                  {c.ackAtISO ? <span className="rounded-full bg-success/15 px-1.5 py-0.5 font-medium text-success">editor has it · {c.ackBy}</span> : <span className="rounded-full bg-warning/15 px-1.5 py-0.5 font-medium text-warning">not acknowledged yet</span>}
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ---- THE SOURCES, shown as sources ---- */}
      <Section icon={Info} title="Where this client's brand lives today" flush>
        <div className="divide-y divide-border text-[13px]">
          <SourceRow label="Brand colours (client record)" value={sources.client.brandColors} />
          <SourceRow label="Brand assets folder (client record)" value={sources.client.brandAssetsPath} />
          <SourceRow label="Headshot / avatar" value={sources.client.avatarUrl} />
          <SourceRow label="Video style (portal)" value={sources.client.portalVideoStyle} />
          <SourceRow label="Preferences (portal)" value={sources.client.portalPreferences} />
          <SourceRow label="Customer note" value={sources.client.generalNotes} />
          {Object.entries(sources.profile).map(([section, kv]) => (
            Object.keys(kv).length > 0 ? (
              <div key={section} className="px-5 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">AI profile · {section}</p>
                {Object.entries(kv).map(([k, v]) => <p key={k} className="text-muted"><span className="text-foreground/80">{k}:</span> {v.slice(0, 220)}</p>)}
              </div>
            ) : null
          ))}
        </div>
      </Section>

      {/* ---- THE DROPBOX FOLDER — the file store, unchanged ---- */}
      <Section
        icon={FolderOpen}
        title="Client folder (Dropbox)"
        count={sources.folder?.files.length ?? null}
        flush
        action={sources.folder?.folderUrl ? <a href={sources.folder.folderUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-brand hover:underline">Open in Dropbox →</a> : undefined}
      >
        <div className="divide-y divide-border">
          {!sources.folder && <p className="px-5 py-3 text-sm text-muted">Dropbox is not connected in this environment, so the folder could not be listed.</p>}
          {sources.folder && !sources.folder.folderExists && <p className="px-5 py-3 text-sm text-muted">No folder yet at <span className="font-mono text-[12px]">{sources.folder.path}</span> — the hourly sweep creates one for every video client.</p>}
          {sources.folder?.files.map((f) => (
            <div key={f.path} className="flex flex-wrap items-center gap-2 px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{f.url ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{f.name}</a> : f.name}</span>
              {f.tracked ? (
                <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">tracked</span>
              ) : canEdit ? (
                <TrackFile enrollmentId={enrollmentId} clientId={clientId} file={f} types={types} busy={busy} start={start} say={say} />
              ) : (
                <span className="text-[11px] text-muted-2">in the folder, not tracked</span>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* ---- PROVENANCE: the client-owned preferences that also reach the editor ---- */}
      <Section
        icon={Quote}
        title="Client preferences that reach the editor brief"
        count={provenance.length}
        flush
        action={<span className="hidden text-[11px] text-muted-2 sm:inline">accepted facts only — a proposed one never leaves this building</span>}
      >
        <div className="divide-y divide-border">
          {provenance.length === 0 && <p className="px-5 py-3 text-sm text-muted">No accepted preferences yet.</p>}
          {provenance.map((f) => (
            <div key={f.id} className="px-5 py-2 text-[13px]">
              <p>{f.body}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 font-medium text-muted">from {f.source}</span>
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-muted-2">{f.category.toLowerCase().replace(/_/g, " ")}</span>
                {f.scope === "PROJECT" && <span className="rounded-full bg-warning/15 px-1.5 py-0.5 font-medium text-warning">this shoot only — not a standing preference</span>}
                {f.scope === "MONTH" && <span className="rounded-full bg-brand-soft px-1.5 py-0.5 font-medium text-brand">this month only</span>}
                {f.factDateISO && <span className="text-muted-2">{day(f.factDateISO)}</span>}
              </p>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function SourceRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 px-5 py-2">
      <span className="w-52 shrink-0 text-muted">{label}</span>
      <span className={value ? "min-w-0 flex-1 break-words" : "text-muted-2"}>{value ? value.slice(0, 300) : "not set"}</span>
    </div>
  );
}

function AssetRow({
  a, enrollmentId, canEdit, busy, start, say,
}: { a: AssetUi; enrollmentId: string; canEdit: boolean; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  const [notes, setNotes] = useState(a.notes ?? "");
  const [ownership, setOwnership] = useState(a.ownership);
  const [text, setText] = useState("");
  const [ref, setRef] = useState("");
  const [why, setWhy] = useState("");
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{a.name}</span>
        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-2">{a.ownership.toLowerCase()}</span>
        {a.profileKey && <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">{["fonts", "website", "social", "music"].includes(a.profileKey) ? "client profile" : "profile preference"}</span>}
        {a.status !== "ACTIVE" && <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-2">retired</span>}
        {a.active && <span className="text-[11px] text-muted-2">v{a.active.versionNo} · {day(a.active.createdAtISO)}{a.active.uploadedBy ? ` · ${a.active.uploadedBy}` : ""}</span>}
        {canEdit && (
          <span className="ml-auto flex gap-1.5">
            <button className={quiet} disabled={busy} onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "Replace"}</button>
            <button className={quiet} disabled={busy} onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit label"}</button>
            <button className={quiet} disabled={busy} onClick={() => start(async () => say(await retireAssetAction(enrollmentId, a.id, a.status === "ACTIVE")))}>
              {a.status === "ACTIVE" ? "Retire" : "Reactivate"}
            </button>
          </span>
        )}
      </div>
      {a.active?.valueText && <p className="mt-1 whitespace-pre-wrap text-[13px] text-foreground/85">{a.active.valueText}</p>}
      {a.active?.cleared && <p className="mt-1 text-[13px] italic text-muted">Cleared — nothing on file, on purpose.</p>}
      {a.active?.fileName && (
        <p className="mt-1 text-[13px]">
          {a.active.url ? <a href={a.active.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{a.active.fileName}</a> : a.active.fileName}
        </p>
      )}
      {a.notes && <p className="mt-1 text-[12px] text-muted">{a.notes}</p>}

      {/* Label, ownership and the standing note — metadata only. Changing
          these never creates a version: the ASSET is the same asset. */}
      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
          <input className={`${input} flex-1`} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          <select className={input} value={ownership} onChange={(e) => setOwnership(e.target.value)} disabled={busy}>
            <option value="CLIENT">client owns it</option><option value="AGENCY">we own it</option><option value="LICENSED">licensed</option>
          </select>
          <input className={`${input} w-full`} placeholder="Note (why it exists, where it may be used)" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} />
          <button className={btn} disabled={busy || name.trim().length < 2} onClick={() => start(async () => { const r = await updateAssetMetaAction(enrollmentId, a.id, { name, ownership, notes: notes.trim() || null }); say(r); if (r.ok) setEditing(false); })}>Save</button>
        </div>
      )}

      {adding && (
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          {a.isText ? (
            <textarea className={`${input} h-20 w-full`} placeholder="The new value" value={text} onChange={(e) => setText(e.target.value)} />
          ) : (
            <input className={`${input} w-full`} placeholder="Dropbox path or URL of the replacement file" value={ref} onChange={(e) => setRef(e.target.value)} />
          )}
          <input className={`${input} w-full`} placeholder="What changed (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
          <div className="flex items-center gap-2">
            <button
              className={btn}
              disabled={busy || (a.isText ? !text.trim() : !ref.trim())}
              onClick={() => start(async () => {
                const r = await addAssetVersionAction(enrollmentId, a.id, { valueText: a.isText ? text : null, fileRef: a.isText ? null : ref.trim(), fileName: a.isText ? null : ref.split("/").pop() ?? null, note: why.trim() || null });
                say(r); if (r.ok) { setAdding(false); setText(""); setRef(""); setWhy(""); }
              })}
            >
              Save as a new version
            </button>
            <span className="text-[11px] text-muted-2">future work uses this; delivered work is untouched</span>
          </div>
        </div>
      )}

      {a.versions.length > 1 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted"><History className="mr-1 inline size-3" />{a.versions.length} versions</summary>
          <div className="mt-1 space-y-1">
            {a.versions.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className={v.id === a.active?.id ? "font-semibold" : "text-muted"}>v{v.versionNo}</span>
                <span className="text-muted-2">{day(v.createdAtISO)} · {v.source}{v.uploadedBy ? ` · ${v.uploadedBy}` : ""}</span>
                <span className="min-w-0 flex-1 truncate">{v.cleared ? "(cleared)" : v.valueText ?? v.fileName ?? "—"}</span>
                {v.note && <span className="text-muted-2">{v.note}</span>}
                {canEdit && v.id !== a.active?.id && (
                  <button className={quiet} disabled={busy} onClick={() => start(async () => say(await setActiveAssetVersionAction(enrollmentId, a.id, v.id)))}>Make current</button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function NewAsset({
  enrollmentId, clientId, types, busy, start, say,
}: { enrollmentId: string; clientId: string; types: { key: string; word: string }[]; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void }) {
  const [type, setType] = useState(types[0]?.key ?? "LOGO");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [ref, setRef] = useState("");
  const [ownership, setOwnership] = useState("CLIENT");
  const isText = TEXT_TYPES.has(type);
  return (
    <Section icon={Plus} title="Track something new">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <select className={input} value={type} onChange={(e) => setType(e.target.value)} disabled={busy}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.word}</option>)}
          </select>
          <input className={`${input} flex-1`} placeholder="Name it (e.g. Primary logo, on-camera colours)" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          <select className={input} value={ownership} onChange={(e) => setOwnership(e.target.value)} disabled={busy}>
            <option value="CLIENT">the client owns it</option><option value="AGENCY">we own it</option><option value="LICENSED">licensed</option>
          </select>
        </div>
        {isText ? (
          <textarea className={`${input} h-20 w-full`} placeholder="The value — colours, pronunciation, the instruction the editor must follow every time…" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
        ) : (
          <input className={`${input} w-full`} placeholder="Dropbox path (/Clients/…/Brand/logo.png) or a URL" value={ref} onChange={(e) => setRef(e.target.value)} disabled={busy} />
        )}
        <button
          className={btn}
          disabled={busy || name.trim().length < 2 || (isText ? !text.trim() : !ref.trim())}
          onClick={() => start(async () => {
            const r = await createAssetAction(enrollmentId, { clientId, type, name, ownership, valueText: isText ? text : null, fileRef: isText ? null : ref.trim(), fileName: isText ? null : ref.split("/").pop() ?? null });
            say(r); if (r.ok) { setName(""); setText(""); setRef(""); }
          })}
        >
          <Sparkles className="mr-1 inline size-3.5" /> Add as version 1
        </button>
      </div>
    </Section>
  );
}

function TrackFile({
  enrollmentId, clientId, file, types, busy, start, say,
}: { enrollmentId: string; clientId: string; file: { name: string; path: string }; types: { key: string; word: string }[]; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("LOGO");
  if (!open) return <button className={quiet} disabled={busy} onClick={() => setOpen(true)}><ImageIcon className="mr-1 inline size-3" />Track</button>;
  return (
    <span className="flex items-center gap-1.5">
      <select className={input} value={type} onChange={(e) => setType(e.target.value)} disabled={busy}>
        {types.filter((t) => !TEXT_TYPES.has(t.key)).map((t) => <option key={t.key} value={t.key}>{t.word}</option>)}
      </select>
      <button className={quiet} disabled={busy} onClick={() => start(async () => { const r = await registerFolderFileAction(enrollmentId, { clientId, type, name: file.name, path: file.path, fileName: file.name }); say(r); if (r.ok) setOpen(false); })}>Save</button>
      <button className={quiet} onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}
