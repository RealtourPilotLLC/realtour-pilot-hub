"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, Eye, EyeOff, Plus } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { createResourceAction, updateResourceAction, publishResourceAction, reviewResourceAction, type ResourceActionResult } from "@/app/content/resources/actions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// RESOURCES AUTHORING (spec §11). Staff write the client guides here and they
// take effect without a deploy, because the body is markdown in the row.
//
// Three rules the screen enforces rather than describes:
//   · a new guide is a DRAFT. No client sees it until somebody publishes it.
//   · a guide cannot be published without an owner and without real content —
//     the server refuses a body that still reads as TODO / TBD / placeholder.
//     Nothing was seeded: an empty group renders as empty, on purpose.
//   · a published guide that has not been reviewed in 90 days is flagged,
//     because platform instructions rot.
// ---------------------------------------------------------------------------

export type ResourceRowUi = {
  id: string; slug: string; groupKey: string; title: string; summary: string | null; body: string;
  platform: string | null; deviceContext: string | null; ownerAppUserId: string | null; ownerName: string | null;
  reviewedAtISO: string | null; linkedActions: string[]; published: boolean; sortOrder: number; stale: boolean;
};

const btn = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center rounded-xl bg-brand-action px-4 py-2 text-sm font-semibold text-brand-fg whitespace-normal hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const quiet = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center rounded-xl border border-border-strong px-3 py-2 text-sm font-medium text-foreground whitespace-normal hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const input = "min-h-11 min-w-0 max-w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-base text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";
const day = (isoStr: string | null) => (isoStr ? new Date(isoStr).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null);
type Receipt = { outcome: "confirmed" | "refused" | "unknown"; message: string };
type RunResource = (label: string, write: () => Promise<ResourceActionResult>, receive: (receipt: Receipt) => void) => void;
type ResourceDraft = { title: string; groupKey: string; summary: string; body: string; platform: string; device: string; owner: string; linked: string[] };
const initialDraft = (initial: ResourceRowUi | null, firstGroup: string): ResourceDraft => ({ title: initial?.title ?? "", groupKey: initial?.groupKey ?? firstGroup, summary: initial?.summary ?? "", body: initial?.body ?? "", platform: initial?.platform ?? "general", device: initial?.deviceContext ?? "any", owner: initial?.ownerAppUserId ?? "", linked: initial?.linkedActions ?? [] });
const draftKey = (draft: ResourceDraft) => JSON.stringify(draft);
// Match only normalization already performed by create/updateResource.
const storedDraftKey = (draft: ResourceDraft) => draftKey({ ...draft, title: draft.title.trim(), summary: draft.summary.trim() });
type FormSession = { draft: ResourceDraft; baseline: string; submitted: ResourceDraft | null; confirmed: ResourceDraft | null; seenConfirmation: number; storedChanged: boolean };
type GuideSession = { editing: boolean; receipt: Receipt | null; confirmedSave: number; form: FormSession };
function newFormSession(initial: ResourceRowUi | null, firstGroup: string): FormSession {
  const draft = initialDraft(initial, firstGroup);
  return { draft, baseline: draftKey(draft), submitted: null, confirmed: null, seenConfirmation: 0, storedChanged: false };
}
const newGuideSession = (row: ResourceRowUi, firstGroup: string): GuideSession => ({ editing: false, receipt: null, confirmedSave: 0, form: newFormSession(row, firstGroup) });
const copyFormSession = (form: FormSession): FormSession => ({ ...form, draft: { ...form.draft, linked: [...form.draft.linked] } });

function ResourceReceipt({ receipt }: { receipt: Receipt | null }) {
  if (!receipt) return null;
  return <div role={receipt.outcome === "confirmed" ? "status" : "alert"} className="break-words rounded-lg border border-border bg-surface px-3 py-2 text-ui-status leading-relaxed">
    <p>{receipt.message}</p>
    {receipt.outcome === "unknown" && <>
      <p className="mt-1">It may already have been applied. Your editor text is kept in this tab. This attempt stays blocked here to prevent a duplicate or an overwrite. Ask staff to verify the stored guide before another write.</p>
      <a className={`${quiet} mt-2`} href="/content/resources" target="_blank" rel="noopener noreferrer">Check guide list in a separate tab</a>
    </>}
  </div>;
}

export function ResourcesAdminPanel({
  rows, groups, platforms, devices, actions, staff, isOwner, readError = false, staffReadError = false,
}: {
  rows: ResourceRowUi[]; groups: { key: string; title: string; blurb: string }[];
  platforms: string[]; devices: string[]; actions: { key: string; label: string }[];
  staff: { id: string; name: string }[]; isOwner: boolean; readError?: boolean; staffReadError?: boolean;
}) {
  const [note, setNote] = useState<Receipt | null>(null);
  const [adding, setAdding] = useState(false);
  const [createReceipt, setCreateReceipt] = useState<Receipt | null>(null);
  const [createVersion, setCreateVersion] = useState(0);
  const createHeld = useRef(false);
  // Guide IDs keep their local recovery evidence even if a refresh relocates
  // a row to another group, or a failed list read temporarily removes it.
  const [guideSessions, setGuideSessions] = useState(() => new Map(rows.map((r) => [r.id, newGuideSession(r, groups[0]?.key ?? "")])));
  const liveSessions = useRef(guideSessions);
  const changeSession = (r: ResourceRowUi, update: (old: GuideSession) => GuideSession) => {
    const next = new Map(liveSessions.current);
    next.set(r.id, update(next.get(r.id) ?? newGuideSession(r, groups[0]?.key ?? "")));
    liveSessions.current = next;
    setGuideSessions(next);
  };
  const [busy, start] = useTransition();
  const pending = useRef(false);
  const isPending = () => pending.current;
  const run: RunResource = (label, write, receive) => {
    if (pending.current) return;
    pending.current = true;
    start(async () => {
      let receipt: Receipt;
      try {
        const r = await write();
        const outcome = r.ok && r.outcome === "confirmed" ? "confirmed" : !r.ok && r.outcome === "refused" ? "refused" : "unknown";
        receipt = { outcome, message: outcome === "unknown" ? `${label} was not confirmed.` : `${label}: ${r.message}` };
      } catch {
        receipt = { outcome: "unknown", message: `${label} was not confirmed.` };
      }
      setNote(receipt);
      receive(receipt);
      pending.current = false;
    });
  };
  const published = rows.filter((r) => r.published).length;

  return (
    <div className="space-y-5">
      <ResourceReceipt receipt={note} />
      {readError && <p role="alert" className="text-ui-status leading-relaxed text-warning">The guide list could not be loaded. Existing guides and publication counts are unknown; this is not evidence that no guides exist. Check the list again before creating a guide that may already exist.</p>}
      {staffReadError && <p role="alert" className="text-ui-status leading-relaxed text-warning">Owner choices could not be loaded. Existing owner selections are kept; owner changes are unavailable until the staff list loads again.</p>}

      {!readError && <p className="text-ui-body leading-relaxed text-muted">
        {rows.length === 0
          ? "No guides exist. Nothing was seeded — a placeholder tutorial published as if it were finished guidance is worse than an empty Resources page, so the first guide gets written by a person."
          : <><span className="font-semibold text-foreground">{published}</span> of {rows.length} are published and visible to clients. {rows.filter((r) => r.stale).length > 0 && `${rows.filter((r) => r.stale).length} have not been reviewed in 90 days.`}</>}
      </p>}

      {groups.map((g) => {
        const mine = rows.filter((r) => r.groupKey === g.key);
        return (
          <Section key={g.key} icon={BookOpen} title={g.title} count={readError ? undefined : mine.length} flush action={<span className="hidden text-ui-status text-muted sm:inline">{g.blurb}</span>}>
            <div className="divide-y divide-border">
              {!readError && mine.length === 0 && <p className="px-5 py-3 text-ui-secondary text-muted">Nothing written for this group yet.</p>}
              {mine.map((r) => (
                <ResourceRow key={r.id} r={r} groups={groups} platforms={platforms} devices={devices} actions={actions} staff={staff} isOwner={isOwner} busy={busy} isPending={isPending} run={run} staffReadError={staffReadError} session={guideSessions.get(r.id) ?? newGuideSession(r, groups[0]?.key ?? "")} getSession={() => liveSessions.current.get(r.id)} sessionChanged={(update) => changeSession(r, update)} />
              ))}
            </div>
          </Section>
        );
      })}

      <Section icon={Plus} title="Write a guide">
        <div hidden={!adding}>
          <ResourceReceipt receipt={createReceipt} />
          <ResourceForm
            key={createVersion}
            groups={groups} platforms={platforms} devices={devices} actions={actions} staff={staff} busy={busy}
            initial={null} isPending={isPending} held={createReceipt?.outcome === "unknown"} staffReadError={staffReadError} confirmedSave={0}
            onCancel={() => { if (!pending.current) setAdding(false); }}
            onSave={(input) => {
              if (createHeld.current) return;
              run(`Create draft guide “${input.title}”`, () => createResourceAction(input), (receipt) => {
                createHeld.current = receipt.outcome === "unknown";
                setCreateReceipt(receipt);
                if (receipt.outcome === "confirmed") { setAdding(false); setCreateVersion((v) => v + 1); }
              });
            }}
          />
        </div>
        {!adding && <button className={btn} disabled={busy} onClick={() => { if (!pending.current) setAdding(true); }}>Open draft editor</button>}
        <p className="mt-2 text-ui-status text-muted">Closing or cancelling keeps your unsaved draft in this tab. A confirmed creation starts a fresh draft.</p>
      </Section>
    </div>
  );
}

function ResourceRow({
  r, groups, platforms, devices, actions, staff, isOwner, busy, isPending, run, staffReadError, session, getSession, sessionChanged,
}: {
  r: ResourceRowUi; groups: { key: string; title: string }[]; platforms: string[]; devices: string[];
  actions: { key: string; label: string }[]; staff: { id: string; name: string }[]; isOwner: boolean;
  busy: boolean; isPending: () => boolean; run: RunResource; staffReadError: boolean;
  session: GuideSession; getSession: () => GuideSession | undefined; sessionChanged: (update: (old: GuideSession) => GuideSession) => void;
}) {
  const { editing, receipt, confirmedSave } = session;
  const setEditing = (next: boolean) => sessionChanged((old) => ({ ...old, editing: next }));
  const held = receipt?.outcome === "unknown";
  const write = (label: string, mutation: () => Promise<ResourceActionResult>, close = false) => {
    if (getSession()?.receipt?.outcome === "unknown" || isPending()) return;
    run(label, mutation, (next) => {
      sessionChanged((old) => ({ ...old, receipt: next, editing: close && next.outcome === "confirmed" ? false : old.editing, confirmedSave: close && next.outcome === "confirmed" ? old.confirmedSave + 1 : old.confirmedSave }));
    });
  };
  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-ui-body font-medium">{r.title}</span>
        <span className={cn("max-w-full rounded-full px-2 py-0.5 text-ui-status font-semibold", r.published ? "bg-success/15 text-success" : "bg-surface-2 text-muted")}>
          {r.published ? <><Eye className="mr-0.5 inline size-3" />published</> : <><EyeOff className="mr-0.5 inline size-3" />draft — no client sees it</>}
        </span>
        {r.platform && <span className="max-w-full break-words rounded-full bg-surface-2 px-2 py-0.5 text-ui-status text-muted">{r.platform}</span>}
        {r.deviceContext && r.deviceContext !== "any" && <span className="max-w-full break-words rounded-full bg-surface-2 px-2 py-0.5 text-ui-status text-muted">{r.deviceContext}</span>}
        {r.stale && <span className="max-w-full rounded-full bg-warning/15 px-2 py-0.5 text-ui-status font-semibold text-warning"><AlertTriangle className="mr-0.5 inline size-3" />not reviewed in 90 days</span>}
        <span className="ml-auto flex max-w-full flex-wrap gap-1.5">
          <button className={quiet} disabled={busy} onClick={() => { if (!isPending()) setEditing(!(getSession()?.editing ?? editing)); }}>{editing ? "Close" : "Edit"}</button>
          <button className={quiet} disabled={busy || held} onClick={() => write(`Review guide “${r.title}”`, () => reviewResourceAction(r.id))}>Still accurate</button>
          {isOwner && (
            <button className={cn(quiet, r.published ? "" : "border-brand text-brand")} disabled={busy || held} onClick={() => write(`${r.published ? "Unpublish" : "Publish"} guide “${r.title}”`, () => publishResourceAction(r.id, !r.published))}>
              {r.published ? "Unpublish" : "Publish"}
            </button>
          )}
        </span>
      </div>
      <p className="mt-1 break-words text-ui-status leading-relaxed text-muted">
        {[r.summary, r.ownerName ? `owner: ${r.ownerName}` : "no owner — it cannot be published without one",
          r.reviewedAtISO ? `reviewed ${day(r.reviewedAtISO)}` : "never reviewed",
          r.linkedActions.length ? `linked from: ${r.linkedActions.map((a) => actions.find((x) => x.key === a)?.label ?? a).join(", ")}` : null].filter(Boolean).join(" · ")}
      </p>
      <ResourceReceipt receipt={receipt} />
        <div hidden={!editing} className="mt-2 border-t border-border pt-2">
          <ResourceForm
            groups={groups} platforms={platforms} devices={devices} actions={actions} staff={staff} busy={busy}
            initial={r} isPending={isPending} held={held} staffReadError={staffReadError} confirmedSave={confirmedSave} cache={session.form} onCacheChange={(form) => sessionChanged((old) => ({ ...old, form }))}
            onCancel={() => { if (!isPending()) setEditing(false); }}
            onSave={(input) => write(`Save guide “${input.title}”`, () => updateResourceAction(r.id, input), true)}
          />
          <p className="mt-2 text-ui-status text-muted">Closing or cancelling keeps your unsaved edits in this tab.</p>
        </div>
    </div>
  );
}

function ResourceForm({
  groups, platforms, devices, actions, staff, busy, initial, onSave, onCancel, isPending, held, staffReadError, confirmedSave, cache, onCacheChange,
}: {
  groups: { key: string; title: string }[]; platforms: string[]; devices: string[]; actions: { key: string; label: string }[];
  staff: { id: string; name: string }[]; busy: boolean; initial: ResourceRowUi | null;
  isPending: () => boolean; held: boolean; staffReadError: boolean; confirmedSave: number;
  cache?: FormSession;
  onCacheChange?: (cache: FormSession) => void;
  onSave: (input: { title: string; groupKey: string; summary: string | null; body: string; platform: string | null; deviceContext: string | null; ownerAppUserId: string | null; linkedActions: string[]; sortOrder: number }) => void;
  onCancel: () => void;
}) {
  const startDraft = cache?.draft ?? initialDraft(initial, groups[0]?.key ?? "");
  const retained = useRef(copyFormSession(cache ?? newFormSession(initial, groups[0]?.key ?? "")));
  const [title, setTitle] = useState(startDraft.title);
  const [groupKey, setGroupKey] = useState(startDraft.groupKey);
  const [summary, setSummary] = useState(startDraft.summary);
  const [body, setBody] = useState(startDraft.body);
  const [platform, setPlatform] = useState(startDraft.platform);
  const [device, setDevice] = useState(startDraft.device);
  const [owner, setOwner] = useState(startDraft.owner);
  const [linked, setLinked] = useState<string[]>(startDraft.linked);
  const [storedChanged, setStoredChanged] = useState(cache?.storedChanged ?? false);
  const incoming = initialDraft(initial, groups[0]?.key ?? "");
  const current: ResourceDraft = { title, groupKey, summary, body, platform, device, owner, linked };
  const incomingKey = draftKey(incoming);
  const currentKey = draftKey(current);
  useEffect(() => {
    const state = retained.current;
    const before = JSON.stringify(state);
    const next = JSON.parse(incomingKey) as ResourceDraft;
    if (confirmedSave !== state.seenConfirmation) {
      state.seenConfirmation = confirmedSave;
      state.confirmed = state.submitted;
    }
    if (busy) { if (before !== JSON.stringify(state)) onCacheChange?.(copyFormSession(state)); return; }
    const exactConfirmed = state.confirmed && currentKey === draftKey(state.confirmed) && storedDraftKey(next) === storedDraftKey(state.confirmed);
    if (incomingKey !== state.baseline || exactConfirmed) {
      if (exactConfirmed || (!state.confirmed && currentKey === state.baseline)) {
        setTitle(next.title); setGroupKey(next.groupKey); setSummary(next.summary); setBody(next.body);
        setPlatform(next.platform); setDevice(next.device); setOwner(next.owner); setLinked(next.linked);
        state.draft = next;
        state.baseline = incomingKey;
        state.confirmed = null;
        state.storedChanged = false;
        setStoredChanged(false);
      } else { state.storedChanged = true; setStoredChanged(true); }
    } else { state.storedChanged = false; setStoredChanged(false); }
    if (before !== JSON.stringify(state)) onCacheChange?.(copyFormSession(state));
  }, [incomingKey, currentKey, busy, confirmedSave, onCacheChange]);
  const change = <K extends keyof ResourceDraft,>(field: K, set: (value: ResourceDraft[K]) => void, value: ResourceDraft[K]) => {
    if (!isPending()) { retained.current.draft = { ...retained.current.draft, [field]: value }; onCacheChange?.(copyFormSession(retained.current)); set(value); }
  };
  const placeholderish = /\b(TODO|TBD|lorem ipsum|placeholder)\b/i.test(body);
  return (
    <div className="space-y-3">
      {storedChanged && <p role="alert" className="text-ui-status leading-relaxed text-warning">The stored guide changed while this editor kept your local text. Your edits are still here; check the current guide in a separate tab before saving over it.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 basis-64 text-ui-secondary font-medium">Title
          <input className={`${input} mt-1 block w-full`} placeholder="Title — what the client is trying to do" value={title} onChange={(e) => change("title", setTitle, e.target.value)} disabled={busy} />
        </label>
        <label className="block max-w-full text-ui-secondary font-medium">Group
        <select className={`${input} mt-1 block`} value={groupKey} onChange={(e) => change("groupKey", setGroupKey, e.target.value)} disabled={busy}>
          {groups.map((g) => <option key={g.key} value={g.key}>{g.title}</option>)}
        </select>
        </label>
      </div>
      <label className="block text-ui-secondary font-medium">Summary
        <input className={`${input} mt-1 block w-full`} placeholder="One line the client reads before opening it" value={summary} onChange={(e) => change("summary", setSummary, e.target.value)} disabled={busy} />
      </label>
      <label className="block text-ui-secondary font-medium">Guide
        <textarea className={`${input} mt-1 block h-48 w-full font-mono`} placeholder="The guide, in markdown." value={body} onChange={(e) => change("body", setBody, e.target.value)} disabled={busy} spellCheck={false} />
      </label>
      {placeholderish && <p className="text-ui-status leading-relaxed text-warning"><AlertTriangle className="mr-1 inline size-3" />This still reads as a placeholder. It can be saved as a draft, but it will be refused at publish.</p>}
      <div className="flex flex-wrap items-end gap-3 text-ui-secondary">
        <label className="block max-w-full font-medium">Platform <select className={`${input} mt-1 block`} value={platform} onChange={(e) => change("platform", setPlatform, e.target.value)} disabled={busy}>{platforms.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label className="block max-w-full font-medium">Device <select className={`${input} mt-1 block`} value={device} onChange={(e) => change("device", setDevice, e.target.value)} disabled={busy}>{devices.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="block max-w-full font-medium">Owner <select className={`${input} mt-1 block`} value={owner} onChange={(e) => { if (!staffReadError) change("owner", setOwner, e.target.value); }} disabled={busy || staffReadError}>
          {owner && !staff.some((s) => s.id === owner) && <option value={owner}>{initial?.ownerName ?? "Current owner"}</option>}
          <option value="">nobody yet</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
      </div>
      <details>
        <summary className="min-h-11 cursor-pointer rounded-lg py-2 text-ui-secondary text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Link it from a task ({linked.length} selected)</summary>
        <div className="mt-1 flex flex-wrap gap-2 text-ui-secondary">
          {actions.map((a) => (
            <label key={a.key} className="flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-border px-3 py-2">
              <input type="checkbox" className="size-4 shrink-0 accent-brand-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" checked={linked.includes(a.key)} disabled={busy}
                onChange={(e) => change("linked", setLinked, e.target.checked ? [...linked, a.key] : linked.filter((k) => k !== a.key))} />
              {a.label}
            </label>
          ))}
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={btn}
          disabled={busy || held || title.trim().length < 3 || !body.trim()}
          onClick={() => { if (!isPending() && !held) { retained.current.submitted = current; onCacheChange?.(copyFormSession(retained.current)); onSave({ title, groupKey, summary: summary.trim() || null, body, platform, deviceContext: device, ownerAppUserId: owner || null, linkedActions: linked, sortOrder: initial?.sortOrder ?? 0 }); } }}
        >
          Save{initial ? "" : " as a draft"}
        </button>
        <button className={quiet} disabled={busy} onClick={() => { if (!isPending()) onCancel(); }}>Cancel</button>
        {!initial && <span className="inline-flex max-w-full items-center gap-1 text-ui-status text-muted"><CheckCircle2 className="size-3 shrink-0" />drafts are invisible to clients</span>}
      </div>
    </div>
  );
}
