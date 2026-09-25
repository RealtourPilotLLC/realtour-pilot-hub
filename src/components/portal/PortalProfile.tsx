"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import {
  CheckCircle2, ChevronRight, FileImage, Globe, ListChecks, Loader2, Music, Palette, Plus, RotateCcw, Sparkles, Type, Upload, UserRound, X,
} from "lucide-react";
import { portalSaveProfile, portalSkipSetupItem, portalUseFolderFile } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { BrandPatch, PortalBrandView, PortalBrandFile } from "@/lib/brandProfile";
import type { SetupChecklist, SetupItem } from "@/lib/portalSetup";

// ---------------------------------------------------------------------------
// MY BRAND PROFILE (CP-06, Sep 24 2026). The client curates what their videos
// look and sound like, one section at a time — colors, logo, headshot, fonts,
// website and social links, music, video style, working preferences, and any
// other brand files — and each section has its own Save with its own result
// beside it, so "saved" always means THIS section was saved.
//
// Every text field can be CLEARED (the old page could not: blanks were
// dropped, and a mixed save said "Saved" while keeping what the client had
// removed). Clearing sends null; the server records it. Uploads go straight to
// the client's own Dropbox folder, where the editors already look, and are
// filed on the profile by kind — Replace makes a new version of THAT file and
// keeps the old one on record. Nothing here is money, and nothing here is ours.
// ---------------------------------------------------------------------------

const HEX_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const parseColors = (s: string): string[] => [...new Set((s.match(HEX_RE) ?? []).map((c) => c.toLowerCase()))];
const SOCIAL = [
  { key: "instagram", label: "Instagram" }, { key: "facebook", label: "Facebook" }, { key: "tiktok", label: "TikTok" },
  { key: "youtube", label: "YouTube" }, { key: "linkedin", label: "LinkedIn" },
] as const;
type SocialKey = (typeof SOCIAL)[number]["key"];
function socialFrom(text: string | null): Record<SocialKey, string> {
  const out = { instagram: "", facebook: "", tiktok: "", youtube: "", linkedin: "" } as Record<SocialKey, string>;
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.+)$/.exec(line);
    const k = m ? SOCIAL.find((s) => s.key === m[1].toLowerCase())?.key : undefined;
    if (k && m) out[k] = m[2].trim();
  }
  return out;
}
const socialText = (o: Record<SocialKey, string>) => SOCIAL.map((s) => (o[s.key].trim() ? `${s.label}: ${o[s.key].trim()}` : null)).filter(Boolean).join("\n");

type Status = { state: "idle" | "saving" | "saved" | "failed"; message?: string };
const input = "mt-1 w-full rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm outline-none focus:border-brand";
const quiet = "inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50";

export function PortalProfile({
  view, suggested, readOnly = false,
}: {
  view: PortalBrandView;
  /** What we already know, offered ONLY for a field that was never set. */
  suggested: { brandColors: string; videoStyle: string; preferences: string };
  /** Not the program owner (or the program is paused/ended): read what is on
   *  file, change nothing. The server refuses regardless. */
  readOnly?: boolean;
}) {
  const initialColors = view.columns.brandColors ?? suggested.brandColors;
  const [files, setFiles] = useState<PortalBrandFile[]>(view.files);
  const byType = (t: string) => files.filter((f) => f.type === t);
  return (
    <div className="space-y-4">
      {readOnly && <p className="rounded-2xl border border-border bg-surface/70 p-3 text-xs text-muted-2">View-only — the program owner can change these.</p>}
      <ColorsSection initial={initialColors} suggested={view.columns.brandColors == null && !!suggested.brandColors} readOnly={readOnly} />
      <FilesSection id="logo" title="Logo" hint="Your logo in the best quality you have — a PNG with a transparent background or an SVG is ideal." kind="LOGO" accept="image/*,.svg,.pdf,.zip" files={byType("LOGO")} setFiles={setFiles} readOnly={readOnly} />
      <FilesSection id="headshot" title="Headshot" hint="A recent, well-lit photo of you. We use it on thumbnails and end cards." kind="HEADSHOT" accept="image/*" files={byType("HEADSHOT")} setFiles={setFiles} readOnly={readOnly} />
      <FontsSection initial={view.slots.fonts} files={byType("FONT")} setFiles={setFiles} readOnly={readOnly} />
      <LinksSection website={view.slots.website} social={view.slots.social} readOnly={readOnly} />
      <TextSection
        id="music" icon={Music} title="Music" field={{ slot: "music" }} initial={view.slots.music ?? ""} rows={2} readOnly={readOnly}
        placeholder="The feel you want — upbeat acoustic, calm piano, no lyrics… or an artist or song you love."
      />
      <TextSection
        id="style" icon={Sparkles} title="Video style & look" field={{ column: "videoStyle" }} initial={view.columns.videoStyle ?? suggested.videoStyle}
        suggested={view.columns.videoStyle == null && !!suggested.videoStyle} rows={3} readOnly={readOnly}
        placeholder="How you like your videos to feel — pacing, text style, captions, colors, energy…"
      />
      <TextSection
        id="preferences" icon={UserRound} title="Working preferences" field={{ column: "preferences" }} initial={view.columns.preferences ?? suggested.preferences}
        suggested={view.columns.preferences == null && !!suggested.preferences} rows={3} readOnly={readOnly}
        placeholder="Scheduling, communication, anything we should always know…"
      />
      <FilesSection
        id="files" title="Other brand files" hint="Brand guides, end cards, anything else your editor should have." kind="OTHER" accept="image/*,.pdf,.zip,.otf,.ttf,.woff,.woff2,.mp4,.mov"
        files={byType("OTHER").concat(files.filter((f) => !["LOGO", "HEADSHOT", "FONT", "OTHER"].includes(f.type)))} setFiles={setFiles} readOnly={readOnly}
        extra={view.folderOnly.length > 0 ? <FolderFiles files={view.folderOnly} readOnly={readOnly} /> : null}
      />
    </div>
  );
}

// ---- pieces -------------------------------------------------------------------------

/**
 * Files already in their brand folder that the profile does not point at
 * (review of CP-06, Sep 24 2026). Their logo is often one of these — uploaded
 * before the profile existed — so each can be filed as the logo or headshot
 * where it is, instead of the client uploading it again as a duplicate.
 */
function FolderFiles({ files, readOnly }: { files: PortalBrandView["folderOnly"]; readOnly: boolean }) {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [filed, setFiled] = useState<Record<string, string>>({});
  const use = (name: string, kind: "LOGO" | "HEADSHOT") =>
    start(async () => {
      const r = await portalUseFolderFile(portalAuthFromLocation(), name, kind).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) setFiled((cur) => ({ ...cur, [name]: kind === "LOGO" ? "your logo" : "your headshot" }));
    });
  return (
    <div id="folder" className="mt-3">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Already in your folder</p>
      <ul className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
        {files.map((f, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs">
            <FileImage className="size-3.5 shrink-0 text-muted-2" />
            {f.url ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:text-brand">{f.name}</a> : <span className="min-w-0 flex-1 truncate">{f.name}</span>}
            {filed[f.name] ? (
              <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="size-3.5" /> {filed[f.name]}</span>
            ) : !readOnly ? (
              <span className="flex shrink-0 gap-1">
                <button type="button" disabled={busy} onClick={() => use(f.name, "LOGO")} className="rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium hover:border-brand hover:text-brand disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">This is my logo</button>
                <button type="button" disabled={busy} onClick={() => use(f.name, "HEADSHOT")} className="rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium hover:border-brand hover:text-brand disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">My headshot</button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted-2">Your editor can see these. If your logo or headshot is here, tap it above. There is no need to upload it again.</p>
      {msg && <p role="status" className={`mt-1 text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}

function StatusLine({ s }: { s: Status }) {
  if (s.state === "saving") return <span className="flex items-center gap-1 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> Saving…</span>;
  if (s.state === "saved") return <span className="flex items-center gap-1 text-xs font-medium text-success"><CheckCircle2 className="size-3.5" /> {s.message}</span>;
  if (s.state === "failed") return <span className="text-xs text-danger">{s.message}</span>;
  return null;
}

function Section({ id, icon: Icon, title, hint, children }: { id: string; icon: typeof Palette; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-brand" /> {title}</h2>
      {hint && <p className="mt-1 text-xs text-muted-2">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function useSaver() {
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [, start] = useTransition();
  const save = (patch: BrandPatch, after?: () => void) =>
    start(async () => {
      setStatus({ state: "saving" });
      const r = await portalSaveProfile(portalAuthFromLocation(), patch).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      if (r.ok) { setStatus({ state: "saved", message: r.message }); after?.(); } else setStatus({ state: "failed", message: r.message });
    });
  return { status, save, busy: status.state === "saving" };
}

function SaveRow({ onSave, onClear, busy, status, canClear, readOnly }: { onSave: () => void; onClear?: () => void; busy: boolean; status: Status; canClear: boolean; readOnly: boolean }) {
  if (readOnly) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button onClick={onSave} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
        {busy && <Loader2 className="size-3.5 animate-spin" />} Save
      </button>
      {onClear && canClear && <button onClick={onClear} disabled={busy} className={quiet}><X className="size-3" /> Clear</button>}
      <StatusLine s={status} />
    </div>
  );
}

function ColorsSection({ initial, suggested, readOnly }: { initial: string; suggested: boolean; readOnly: boolean }) {
  // Brand colors are SWATCHES (Jordan: a color picker, saved codes shown as
  // little circles) — non-hex words from older data survive in the saved
  // string's tail.
  const [colors, setColors] = useState<string[]>(parseColors(initial));
  const extraWords = initial.replace(HEX_RE, "").replace(/[,\s]+/g, " ").trim();
  const [words, setWords] = useState(extraWords);
  const [pick, setPick] = useState("#d95816");
  const { status, save, busy } = useSaver();
  const value = [colors.join(", "), words].filter(Boolean).join(", ");
  return (
    <Section id="colors" icon={Palette} title="Brand colors" hint={suggested ? "We filled these in from what we already know — keep, change or clear them, then Save." : "Pick your colors — your editor matches text, graphics and end cards to them."}>
      <div className="flex flex-wrap items-center gap-2">
        {colors.map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/60 py-1 pl-1.5 pr-2 text-xs font-medium">
            <span className="size-4 rounded-full border border-border-strong" style={{ backgroundColor: c }} />
            {c.toUpperCase()}
            {!readOnly && (
              <button onClick={() => setColors((cur) => cur.filter((x) => x !== c))} aria-label={`Remove ${c}`} className="text-muted-2 hover:text-danger">
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <span className="inline-flex items-center gap-1.5">
            <input type="color" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Pick a brand color" className="size-8 cursor-pointer rounded-lg border border-border bg-surface-2/60 p-0.5" />
            <button onClick={() => setColors((cur) => (cur.includes(pick.toLowerCase()) ? cur : [...cur, pick.toLowerCase()]))} className={quiet}>
              <Plus className="size-3" /> Add
            </button>
          </span>
        )}
        {colors.length === 0 && readOnly && <span className="text-xs text-muted-2">None on file.</span>}
      </div>
      {words && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-2">
          Also on file: {words}
          {!readOnly && <button onClick={() => setWords("")} className="text-muted-2 underline hover:text-danger">remove</button>}
        </p>
      )}
      <SaveRow
        readOnly={readOnly} busy={busy} status={status} canClear={colors.length > 0 || !!words}
        onSave={() => save({ brandColors: value || null })}
        onClear={() => save({ brandColors: null }, () => { setColors([]); setWords(""); })}
      />
    </Section>
  );
}

function TextSection({
  id, icon, title, field, initial, rows, placeholder, suggested = false, readOnly,
}: {
  id: string; icon: typeof Palette; title: string; field: { column: "videoStyle" | "preferences" } | { slot: "music" | "fonts" };
  initial: string; rows: number; placeholder: string; suggested?: boolean; readOnly: boolean;
}) {
  const [text, setText] = useState(initial);
  const { status, save, busy } = useSaver();
  const patchFor = (v: string | null): BrandPatch => ("column" in field ? { [field.column]: v } : { slots: { [field.slot]: v } });
  return (
    <Section id={id} icon={icon} title={title} hint={suggested ? "We filled this in from what we already know — edit it and Save, or Clear it." : undefined}>
      <textarea value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} rows={rows} placeholder={placeholder} className={input} aria-label={title} />
      <SaveRow
        readOnly={readOnly} busy={busy} status={status} canClear={!!text.trim()}
        onSave={() => save(patchFor(text.trim() || null))}
        onClear={() => save(patchFor(null), () => setText(""))}
      />
    </Section>
  );
}

function LinksSection({ website, social, readOnly }: { website: string | null; social: string | null; readOnly: boolean }) {
  const [site, setSite] = useState(website ?? "");
  const [links, setLinks] = useState(socialFrom(social));
  const { status, save, busy } = useSaver();
  const any = !!site.trim() || SOCIAL.some((s) => links[s.key].trim());
  return (
    <Section id="links" icon={Globe} title="Website & social links" hint="Where people find you — your editor uses these for end cards and handles.">
      <label className="block text-xs text-muted">Website
        <input value={site} readOnly={readOnly} onChange={(e) => setSite(e.target.value)} placeholder="https://" className={input} />
      </label>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {SOCIAL.map((s) => (
          <label key={s.key} className="block text-xs text-muted">{s.label}
            <input value={links[s.key]} readOnly={readOnly} onChange={(e) => setLinks((cur) => ({ ...cur, [s.key]: e.target.value }))} placeholder={`Your ${s.label} link or @handle`} className={input} />
          </label>
        ))}
      </div>
      <SaveRow
        readOnly={readOnly} busy={busy} status={status} canClear={any}
        onSave={() => save({ slots: { website: site.trim() || null, social: socialText(links) || null } })}
        onClear={() => save({ slots: { website: null, social: null } }, () => { setSite(""); setLinks(socialFrom(null)); })}
      />
    </Section>
  );
}

function FontsSection({ initial, files, setFiles, readOnly }: { initial: string | null; files: PortalBrandFile[]; setFiles: React.Dispatch<React.SetStateAction<PortalBrandFile[]>>; readOnly: boolean }) {
  return (
    <div id="fonts" className="scroll-mt-24 space-y-2">
      <TextSection id="fonts-names" icon={Type} title="Fonts" field={{ slot: "fonts" }} initial={initial ?? ""} rows={2} readOnly={readOnly} placeholder="The names of your brand fonts — e.g. Montserrat for headings, Lato for body text." />
      <FilesSection id="fonts-files" title="Font files" hint="Optional — upload the font files if you have them (.otf, .ttf, .woff)." kind="FONT" accept=".otf,.ttf,.woff,.woff2,.zip" files={files} setFiles={setFiles} readOnly={readOnly} />
    </div>
  );
}

type Upload = { id: string; file: File; kind: string; replaceAssetId: string | null; progress: number; state: "uploading" | "done" | "failed"; message: string };

function FilesSection({
  id, title, hint, kind, accept, files, setFiles, readOnly, extra,
}: {
  id: string; title: string; hint: string; kind: "LOGO" | "HEADSHOT" | "FONT" | "OTHER"; accept: string;
  files: PortalBrandFile[]; setFiles: React.Dispatch<React.SetStateAction<PortalBrandFile[]>>; readOnly: boolean; extra?: React.ReactNode;
}) {
  const pickRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const patch = (uid: string, p: Partial<Upload>) => setUploads((cur) => cur.map((u) => (u.id === uid ? { ...u, ...p } : u)));

  // XMLHttpRequest, not fetch: it is the one browser API that reports upload
  // progress, and a 20MB logo on a phone deserves a bar, not a spinner.
  const send = (u: Upload) => {
    const form = new FormData();
    const auth = portalAuthFromLocation();
    if (auth.token) form.set("token", auth.token);
    if (auth.enrollmentId) form.set("enrollmentId", auth.enrollmentId);
    form.set("kind", u.kind);
    if (u.replaceAssetId) form.set("assetId", u.replaceAssetId);
    form.set("file", u.file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/portal/upload");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) patch(u.id, { progress: Math.round((e.loaded / e.total) * 100) }); };
    xhr.onerror = () => patch(u.id, { state: "failed", message: "That upload didn't stick — check your connection and retry." });
    xhr.onload = () => {
      let j: { ok?: boolean; message?: string; assetId?: string; versionId?: string; fileName?: string } = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (!j.ok) { patch(u.id, { state: "failed", message: j.message || "That upload didn't stick — retry." }); return; }
      patch(u.id, { state: "done", progress: 100, message: j.message ?? "Uploaded." });
      if (j.assetId) {
        const row: PortalBrandFile = { assetId: j.assetId, type: u.kind, typeWord: title, name: j.fileName ?? u.file.name, fileName: j.fileName ?? u.file.name, url: null, versionNo: 1, updatedAtISO: new Date().toISOString() };
        setFiles((cur) => (u.replaceAssetId ? cur.map((f) => (f.assetId === u.replaceAssetId ? { ...row, type: f.type, typeWord: f.typeWord, versionNo: f.versionNo + 1 } : f)) : [row, ...cur]));
      }
    };
    xhr.send(form);
  };
  const start = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const replaceAssetId = replacing;
    const next = Array.from(list).slice(0, replaceAssetId ? 1 : 5).map((file, i) => ({
      id: `${Date.now()}-${i}`, file, kind, replaceAssetId, progress: 0, state: "uploading" as const, message: "",
    }));
    setUploads((cur) => [...next, ...cur].slice(0, 12));
    next.forEach(send);
    setReplacing(null);
    if (pickRef.current) pickRef.current.value = "";
  };
  const icon = kind === "FONT" ? Type : FileImage;
  return (
    <Section id={id} icon={icon} title={title} hint={hint}>
      {files.length > 0 && (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {files.map((f) => (
            <li key={f.assetId} className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-xs">
              <FileImage className="size-3.5 shrink-0 text-muted-2" />
              {f.url ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:text-brand">{f.fileName ?? f.name}</a> : <span className="min-w-0 truncate">{f.fileName ?? f.name}</span>}
              {!readOnly && (
                <button onClick={() => { setReplacing(f.assetId); pickRef.current?.click(); }} className="ml-auto shrink-0 text-[11px] font-medium text-brand hover:underline">Replace</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {files.length === 0 && readOnly && <p className="text-xs text-muted-2">Nothing uploaded yet.</p>}
      {!readOnly && (
        <button onClick={() => { setReplacing(null); pickRef.current?.click(); }} className={`${files.length ? "mt-2 " : ""}inline-flex items-center gap-1.5 rounded-xl border border-dashed border-border px-4 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground`}>
          <Upload className="size-4" /> {files.length ? `Add another` : `Upload ${title.toLowerCase()}`}
        </button>
      )}
      <input ref={pickRef} type="file" multiple={!replacing} hidden accept={accept} onChange={(e) => start(e.target.files)} />
      {uploads.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {uploads.map((u) => (
            <li key={u.id} className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{u.replaceAssetId ? "Replacing with " : ""}{u.file.name}</span>
                {u.state === "uploading" && <span className="tabular-nums text-muted">{u.progress}%</span>}
                {u.state === "done" && <CheckCircle2 className="size-3.5 text-success" />}
                {u.state === "failed" && (
                  <button onClick={() => { patch(u.id, { state: "uploading", progress: 0, message: "" }); send({ ...u, state: "uploading", progress: 0 }); }} className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline">
                    <RotateCcw className="size-3" /> Retry
                  </button>
                )}
              </div>
              {u.state === "uploading" && <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-brand" style={{ width: `${u.progress}%` }} /></div>}
              {u.message && <p className={u.state === "failed" ? "mt-0.5 text-danger" : "mt-0.5 text-muted"}>{u.message}</p>}
            </li>
          ))}
        </ul>
      )}
      {extra}
    </Section>
  );
}

// ---- the Home checklist card ---------------------------------------------------------------

export type SetupCardData = Omit<SetupChecklist, "items"> & { items: (SetupItem & { href: string })[] };

/**
 * Account setup on Home, until it is complete. Shows the next three things
 * not done and not skipped, each with "Skip for now"; a skipped item still
 * counts as not done and sits under "Skipped". When only skipped items are
 * left, the card shrinks to one line that stays until the setup is complete.
 */
export function SetupCard({ d }: { d: SetupCardData }) {
  const [items, setItems] = useState(d.items);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const toggle = (key: string, skip: boolean) =>
    start(async () => {
      const r = await portalSkipSetupItem(portalAuthFromLocation(), key, skip).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      if (!r.ok) { setErr(r.message); return; }
      setErr(null);
      setItems((cur) => cur.map((i) => (i.key === key ? { ...i, skippedAtISO: skip ? new Date().toISOString() : null } : i)));
    });
  const todo = items.filter((i) => !i.done && !i.skippedAtISO);
  const skipped = items.filter((i) => !i.done && i.skippedAtISO);
  const required = todo.filter((i) => !i.optional).concat(todo.filter((i) => i.optional));
  const firstHref = (required[0] ?? skipped[0])?.href;
  if (required.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface/70 px-4 py-3 text-sm">
        <ListChecks className="size-4 shrink-0 text-brand" />
        <span className="font-medium">Account setup {d.done} of {d.total}</span>
        <span className="text-muted">· finish any time</span>
        {firstHref && <Link href={firstHref} className="ml-auto text-xs font-medium text-brand hover:underline">Pick up where you left off →</Link>}
        <SkippedList items={skipped} busy={busy} onRestore={(k) => toggle(k, false)} />
        {err && <p className="w-full text-xs text-danger">{err}</p>}
      </div>
    );
  }
  return (
    <div className="panel-shadow rounded-2xl border border-brand/30 bg-surface/70 p-4 backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold"><ListChecks className="size-4 text-brand" /> Set up your account</span>
        <span className="text-xs font-medium tabular-nums text-muted">{d.done} of {d.total} done</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-gradient-to-r from-brand to-orange-400" style={{ width: `${Math.round((d.done / Math.max(1, d.total)) * 100)}%` }} />
      </div>
      <ol className="mt-3 space-y-1.5">
        {required.slice(0, 3).map((i) => (
          <li key={i.key} className="flex items-center gap-2">
            <Link href={i.href} className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
              <span className="min-w-0 flex-1">{i.label}{i.optional ? <span className="ml-1 text-xs font-normal text-muted-2">(optional)</span> : null}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-2" />
            </Link>
            <button disabled={busy} onClick={() => toggle(i.key, true)} className="shrink-0 text-xs text-muted hover:text-foreground hover:underline disabled:opacity-50">Skip for now</button>
          </li>
        ))}
      </ol>
      <SkippedList items={skipped} busy={busy} onRestore={(k) => toggle(k, false)} />
      {err && <p className="mt-1.5 text-xs text-danger">{err}</p>}
    </div>
  );
}

function SkippedList({ items, busy, onRestore }: { items: (SetupItem & { href: string })[]; busy: boolean; onRestore: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <details className="mt-2 w-full text-xs">
      <summary className="cursor-pointer text-muted">Skipped ({items.length})</summary>
      <ul className="mt-1.5 space-y-1">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-2">
            <Link href={i.href} className="min-w-0 flex-1 truncate hover:text-brand">{i.label}</Link>
            <button disabled={busy} onClick={() => onRestore(i.key)} className="shrink-0 text-muted hover:text-foreground hover:underline disabled:opacity-50">Put back</button>
          </li>
        ))}
      </ul>
    </details>
  );
}
