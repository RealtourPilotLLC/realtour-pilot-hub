"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, Eye, EyeOff, Plus } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { createResourceAction, updateResourceAction, publishResourceAction, reviewResourceAction } from "@/app/content/resources/actions";
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

export function ResourcesAdminPanel({
  rows, groups, platforms, devices, actions, staff, isOwner,
}: {
  rows: ResourceRowUi[]; groups: { key: string; title: string; blurb: string }[];
  platforms: string[]; devices: string[]; actions: { key: string; label: string }[];
  staff: { id: string; name: string }[]; isOwner: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, start] = useTransition();
  const say = (r: { ok: boolean; message: string }) => setNote(`${r.ok ? "" : "Couldn't do that — "}${r.message}`);
  const published = rows.filter((r) => r.published).length;

  return (
    <div className="space-y-5">
      {note && <p role="status" className="break-words rounded-lg border border-border bg-surface px-3 py-2 text-ui-status leading-relaxed">{note}</p>}

      <p className="text-ui-body leading-relaxed text-muted">
        {rows.length === 0
          ? "No guides exist. Nothing was seeded — a placeholder tutorial published as if it were finished guidance is worse than an empty Resources page, so the first guide gets written by a person."
          : <><span className="font-semibold text-foreground">{published}</span> of {rows.length} are published and visible to clients. {rows.filter((r) => r.stale).length > 0 && `${rows.filter((r) => r.stale).length} have not been reviewed in 90 days.`}</>}
      </p>

      {groups.map((g) => {
        const mine = rows.filter((r) => r.groupKey === g.key);
        return (
          <Section key={g.key} icon={BookOpen} title={g.title} count={mine.length} flush action={<span className="hidden text-ui-status text-muted sm:inline">{g.blurb}</span>}>
            <div className="divide-y divide-border">
              {mine.length === 0 && <p className="px-5 py-3 text-ui-secondary text-muted">Nothing written for this group yet.</p>}
              {mine.map((r) => (
                <ResourceRow key={r.id} r={r} groups={groups} platforms={platforms} devices={devices} actions={actions} staff={staff} isOwner={isOwner} busy={busy} start={start} say={say} />
              ))}
            </div>
          </Section>
        );
      })}

      <Section icon={Plus} title="Write a guide">
        {adding ? (
          <ResourceForm
            groups={groups} platforms={platforms} devices={devices} actions={actions} staff={staff} busy={busy}
            initial={null}
            onCancel={() => setAdding(false)}
            onSave={(input) => start(async () => { const r = await createResourceAction(input); say(r); if (r.ok) setAdding(false); })}
          />
        ) : (
          <button className={btn} onClick={() => setAdding(true)}>Start a new guide</button>
        )}
      </Section>
    </div>
  );
}

function ResourceRow({
  r, groups, platforms, devices, actions, staff, isOwner, busy, start, say,
}: {
  r: ResourceRowUi; groups: { key: string; title: string }[]; platforms: string[]; devices: string[];
  actions: { key: string; label: string }[]; staff: { id: string; name: string }[]; isOwner: boolean;
  busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
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
          <button className={quiet} disabled={busy} onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
          <button className={quiet} disabled={busy} onClick={() => start(async () => say(await reviewResourceAction(r.id)))}>Still accurate</button>
          {isOwner && (
            <button className={cn(quiet, r.published ? "" : "border-brand text-brand")} disabled={busy} onClick={() => start(async () => say(await publishResourceAction(r.id, !r.published)))}>
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
      {editing && (
        <div className="mt-2 border-t border-border pt-2">
          <ResourceForm
            groups={groups} platforms={platforms} devices={devices} actions={actions} staff={staff} busy={busy}
            initial={r}
            onCancel={() => setEditing(false)}
            onSave={(input) => start(async () => { const x = await updateResourceAction(r.id, input); say(x); if (x.ok) setEditing(false); })}
          />
        </div>
      )}
    </div>
  );
}

function ResourceForm({
  groups, platforms, devices, actions, staff, busy, initial, onSave, onCancel,
}: {
  groups: { key: string; title: string }[]; platforms: string[]; devices: string[]; actions: { key: string; label: string }[];
  staff: { id: string; name: string }[]; busy: boolean; initial: ResourceRowUi | null;
  onSave: (input: { title: string; groupKey: string; summary: string | null; body: string; platform: string | null; deviceContext: string | null; ownerAppUserId: string | null; linkedActions: string[]; sortOrder: number }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [groupKey, setGroupKey] = useState(initial?.groupKey ?? groups[0]?.key ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [platform, setPlatform] = useState(initial?.platform ?? "general");
  const [device, setDevice] = useState(initial?.deviceContext ?? "any");
  const [owner, setOwner] = useState(initial?.ownerAppUserId ?? "");
  const [linked, setLinked] = useState<string[]>(initial?.linkedActions ?? []);
  const placeholderish = /\b(TODO|TBD|lorem ipsum|placeholder)\b/i.test(body);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 basis-64 text-ui-secondary font-medium">Title
          <input className={`${input} mt-1 block w-full`} placeholder="Title — what the client is trying to do" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </label>
        <label className="block max-w-full text-ui-secondary font-medium">Group
        <select className={`${input} mt-1 block`} value={groupKey} onChange={(e) => setGroupKey(e.target.value)} disabled={busy}>
          {groups.map((g) => <option key={g.key} value={g.key}>{g.title}</option>)}
        </select>
        </label>
      </div>
      <label className="block text-ui-secondary font-medium">Summary
        <input className={`${input} mt-1 block w-full`} placeholder="One line the client reads before opening it" value={summary} onChange={(e) => setSummary(e.target.value)} disabled={busy} />
      </label>
      <label className="block text-ui-secondary font-medium">Guide
        <textarea className={`${input} mt-1 block h-48 w-full font-mono`} placeholder="The guide, in markdown." value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} spellCheck={false} />
      </label>
      {placeholderish && <p className="text-ui-status leading-relaxed text-warning"><AlertTriangle className="mr-1 inline size-3" />This still reads as a placeholder. It can be saved as a draft, but it will be refused at publish.</p>}
      <div className="flex flex-wrap items-end gap-3 text-ui-secondary">
        <label className="block max-w-full font-medium">Platform <select className={`${input} mt-1 block`} value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={busy}>{platforms.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label className="block max-w-full font-medium">Device <select className={`${input} mt-1 block`} value={device} onChange={(e) => setDevice(e.target.value)} disabled={busy}>{devices.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="block max-w-full font-medium">Owner <select className={`${input} mt-1 block`} value={owner} onChange={(e) => setOwner(e.target.value)} disabled={busy}>
          <option value="">nobody yet</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
      </div>
      <details>
        <summary className="min-h-11 cursor-pointer rounded-lg py-2 text-ui-secondary text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Link it from a task ({linked.length} selected)</summary>
        <div className="mt-1 flex flex-wrap gap-2 text-ui-secondary">
          {actions.map((a) => (
            <label key={a.key} className="flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-border px-3 py-2">
              <input type="checkbox" className="size-4 shrink-0 accent-brand-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" checked={linked.includes(a.key)} disabled={busy}
                onChange={(e) => setLinked(e.target.checked ? [...linked, a.key] : linked.filter((k) => k !== a.key))} />
              {a.label}
            </label>
          ))}
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={btn}
          disabled={busy || title.trim().length < 3 || !body.trim()}
          onClick={() => onSave({ title, groupKey, summary: summary.trim() || null, body, platform, deviceContext: device, ownerAppUserId: owner || null, linkedActions: linked, sortOrder: initial?.sortOrder ?? 0 })}
        >
          Save{initial ? "" : " as a draft"}
        </button>
        <button className={quiet} onClick={onCancel}>Cancel</button>
        {!initial && <span className="inline-flex max-w-full items-center gap-1 text-ui-status text-muted"><CheckCircle2 className="size-3 shrink-0" />drafts are invisible to clients</span>}
      </div>
    </div>
  );
}
