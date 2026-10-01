"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Copy, ChevronDown, Shield, Ban, RotateCcw, Trash2, X, Eye } from "lucide-react";
import { ROLES, ROLE_LABEL, PAGES, roleHasByDefault, parsePermissions, canAccess, type PageKey } from "@/lib/auth/access";
import { inviteUser, inviteLinkFor, setUserRole, setUserPermission, resetUserPermissions, setUserStatus, removeUser, viewAs, type UserActionResult } from "@/app/users/actions";
import { etMonthDay } from "@/lib/datetime";
import { Button } from "@/components/ui/Action";
import { CopyButton } from "@/components/ui/CopyButton";

export type UserView = { id: string; email: string; name: string | null; role: string; permissions: string | null; status: string; lastLoginAt: string | null; isSelf: boolean };
const STATUS_STYLE: Record<string, string> = { ACTIVE: "bg-success/10 text-success", INVITED: "bg-warning/10 text-warning", DISABLED: "bg-danger/10 text-danger" };
const field = "min-h-11 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";
type Receipt = UserActionResult & { label: string };
type Run = (label: string, write: () => Promise<UserActionResult>, confirmed?: (r: UserActionResult) => void) => void;

/** One account's role, overrides, link, status and removal share a guard.
 * Recovery stores only an opaque attempt, never an email, password or link. */
function useUserMutation(scope: string) {
  const [busy, start] = useTransition();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const pending = useRef(false), held = useRef(false);
  const storageKey = `ops-user-attempt:${scope}`;
  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped || pending.current) return;
      try { if (sessionStorage.getItem(storageKey)) { held.current = true; setReceipt({ ok: false, outcome: "unknown", label: "Previous request", message: "A previous request in this tab is unconfirmed." }); } }
      catch { /* Submission refuses if it cannot persist a recovery marker. */ }
    });
    return () => { stopped = true; };
  }, [storageKey]);
  const run: Run = (label, write, confirmed) => {
    if (pending.current || held.current) return;
    let attempt: string;
    try {
      if (sessionStorage.getItem(storageKey)) {
        held.current = true;
        setReceipt({ ok: false, outcome: "unknown", label, message: "A previous request in this tab is unconfirmed." });
        return;
      }
      attempt = crypto.randomUUID();
      sessionStorage.setItem(storageKey, attempt);
    } catch {
      setReceipt({ ok: false, outcome: "refused", label, message: "This browser could not keep recovery status. No request was made. Restore browser storage before trying again." });
      return;
    }
    pending.current = true;
    setReceipt(null);
    start(async () => {
      let r: UserActionResult;
      try {
        const result = await write();
        r = result.ok && result.outcome === "confirmed" || !result.ok && (result.outcome === "refused" || result.outcome === "unknown")
          ? result : { ok: false, outcome: "unknown", message: "The request was not confirmed." };
      } catch { r = { ok: false, outcome: "unknown", message: "The request was not confirmed." }; }
      if (r.outcome !== "unknown") {
        try { if (sessionStorage.getItem(storageKey) === attempt) sessionStorage.removeItem(storageKey); }
        catch { r = { ok: false, outcome: "unknown", message: `${r.message} Local recovery status could not be cleared.` }; }
      }
      held.current = r.outcome === "unknown";
      setReceipt({ ...r, label });
      pending.current = false;
      if (r.ok) confirmed?.(r);
    });
  };
  return { busy, receipt, run, held: receipt?.outcome === "unknown", isPending: () => pending.current };
}

function UserReceipt({ receipt, userId }: { receipt: Receipt | null; userId?: string }) {
  if (!receipt) return null;
  return <div role={receipt.ok ? "status" : "alert"} className={`mt-3 space-y-2 break-words text-ui-status leading-relaxed ${receipt.ok ? "text-success" : "text-danger"}`}>
    <p><span className="font-semibold">{receipt.label}:</span> {receipt.message}</p>
    {receipt.outcome === "unknown" && <>
      <p>The change may already have happened. Further changes {userId ? "to this account" : "from this invite form"} stay blocked in this tab, including after refresh. Check the account and activity before another attempt. Refreshing does not prove that nothing changed.</p>
      {userId && <p className="text-muted">Account reference: <span className="font-mono">{userId}</span></p>}
      <a href={`/users?tab=logins${userId ? `#user-${userId}` : ""}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong px-3 py-2 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Inspect logins in a separate tab</a>
    </>}
  </div>;
}

function CopyLink({ link }: { link: string }) {
  return <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/60 p-2">
    <input aria-label="Invite or password setup link" readOnly value={link} className={`${field} min-w-0 flex-1`} />
    <CopyButton value={link} label="Copy link" title="Copy invite or password setup link" />
  </div>;
}

type InviteDraft = { email: string; name: string; role: string };
function AddUser() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<InviteDraft>({ email: "", name: "", role: "PHOTOGRAPHER" });
  const current = useRef(draft);
  const [link, setLink] = useState<{ value: string; email: string; role: string; keptNewer: boolean } | null>(null);
  const { busy, receipt, run, held, isPending } = useUserMutation("invite-form");
  const addButton = useRef<HTMLButtonElement>(null), emailInput = useRef<HTMLInputElement>(null), focusToggle = useRef(false);
  useEffect(() => { if (focusToggle.current) { (open ? emailInput.current : addButton.current)?.focus(); focusToggle.current = false; } }, [open]);
  const change = (patch: Partial<InviteDraft>) => { current.current = { ...current.current, ...patch }; setDraft(current.current); };
  const submit = () => {
    const submitted = { ...current.current };
    if (!submitted.email.trim()) return;
    run(`Invite for ${submitted.email}`, async () => {
      setLink(null); // A re-invite can replace the earlier token for this email.
      const r = await inviteUser(submitted);
      return r.ok && !r.link ? { ok: false, outcome: "unknown", message: "The invite response did not include its link." } : r;
    }, (r) => {
      const unchanged = JSON.stringify(current.current) === JSON.stringify(submitted);
      setLink({ value: r.link!, email: submitted.email, role: submitted.role, keptNewer: !unchanged });
      if (unchanged) change({ email: "", name: "" });
    });
  };
  return <div>
    {!open && <Button ref={addButton} onClick={() => { focusToggle.current = true; setOpen(true); }}><UserPlus className="size-4" /> Add a user</Button>}
    <div hidden={!open} className="panel-shadow rounded-2xl border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Invite someone</h3>
        <Button variant="quiet" aria-label="Close invite form and keep draft" disabled={busy} onClick={() => { if (!isPending()) { focusToggle.current = true; setOpen(false); } }}><X className="size-4" /></Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-muted">Email (their Google login)<input ref={emailInput} type="email" value={draft.email} onChange={(e) => change({ email: e.target.value })} placeholder="name@example.com" className={field} /></label>
        <label className="flex flex-col gap-1 text-sm text-muted">Name (optional)<input value={draft.name} onChange={(e) => change({ name: e.target.value })} placeholder="First Last" className={field} /></label>
        <label className="flex flex-col gap-1 text-sm text-muted">Role<select value={draft.role} onChange={(e) => change({ role: e.target.value })} className={field}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
        <Button busy={busy} disabled={held || !draft.email.trim()} onClick={submit}><UserPlus className="size-4" /> Create invite</Button>
      </div>
      <UserReceipt receipt={receipt} />
      {link && <div className="mt-3 text-ui-status leading-relaxed">
        <p className="text-success">Confirmed invite link for {link.email} ({ROLE_LABEL[link.role]}). Share it when ready; creating it does not send it.</p>
        {link.keptNewer && <p className="text-muted">Your newer form input was kept. This link belongs to the submitted invite shown above.</p>}
        <CopyLink link={link.value} />
      </div>}
      <p className="mt-2 text-ui-status text-muted">Closing keeps the current draft and receipt here. Unsaved draft words are not kept after a page reload.</p>
    </div>
  </div>;
}

function AccessToggles({ u, busy, held, run }: { u: UserView; busy: boolean; held: boolean; run: Run }) {
  const baseline = { role: u.role, permissions: u.permissions };
  const toggle = (key: PageKey, next: boolean) => {
    const def = roleHasByDefault(u.role, key);
    run(`${PAGES.find((p) => p.key === key)?.label ?? key} access`, () => setUserPermission(u.id, key, next === def ? null : next, baseline));
  };
  return <div className="mt-3 rounded-xl border border-border bg-surface-2/40 p-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-semibold text-muted">Page access</span>
      <Button variant="quiet" disabled={busy || held} onClick={() => run("Reset page access", () => resetUserPermissions(u.id, baseline))}><RotateCcw className="size-4" /> Reset to {ROLE_LABEL[u.role]} defaults</Button>
    </div>
    <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-3">
      {PAGES.filter((p) => !p.ownerOnly).map((p) => {
        const on = canAccess(u, p.key), overridden = p.key in parsePermissions(u.permissions);
        return <label key={p.key} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand">
          <input type="checkbox" checked={on} disabled={busy || held} onChange={(e) => toggle(p.key, e.target.checked)} className="size-4 accent-[var(--brand)]" />
          <span className={on ? "text-foreground" : "text-muted"}>{p.label}</span>{overridden && <span className="text-ui-status text-brand">custom</span>}
        </label>;
      })}
    </div>
  </div>;
}

function UserCard({ u }: { u: UserView }) {
  const [expanded, setExpanded] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const { busy, receipt, run, held } = useUserMutation(`account:${u.id}`);
  const router = useRouter();
  const neverLoggedIn = !u.lastLoginAt, isOwner = u.role === "OWNER", disabled = busy || held;
  const name = u.name || u.email;
  const changeRole = (role: string) => run(`Role: ${ROLE_LABEL[role]}`, () => setUserRole(u.id, role, { role: u.role, permissions: u.permissions }));
  return <div id={`user-${u.id}`} className="panel-shadow scroll-mt-6 rounded-2xl border bg-surface p-4">
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="break-words text-base font-semibold">{name}</span>{u.isSelf && <span className="rounded bg-surface-2 px-1.5 text-ui-status text-muted">you</span>}
          <span className={`rounded-full px-2 py-1 text-ui-status font-medium ${STATUS_STYLE[u.status] ?? "bg-surface-2 text-muted"}`}>{u.status.toLowerCase()}</span>
        </div>
        <div className="break-words text-ui-secondary leading-relaxed text-muted">{u.email}{u.lastLoginAt ? ` · last in ${etMonthDay(u.lastLoginAt)}` : " · hasn't signed in yet"}</div>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        <select aria-label={`Role for ${name}`} value={u.role} disabled={disabled || (u.isSelf && isOwner)} onChange={(e) => changeRole(e.target.value)} className={`${field} w-auto`}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        {!isOwner && <Button variant="secondary" aria-expanded={expanded} aria-controls={`access-${u.id}`} onClick={() => setExpanded((v) => !v)}><Shield className="size-4" /> Access <ChevronDown className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} /></Button>}
        {!u.isSelf && <Button variant="secondary" disabled={disabled} onClick={() => run(neverLoggedIn ? "Invite link" : "Password setup link", async () => { const r = await inviteLinkFor(u.id); return r.ok && !r.link ? { ok: false, outcome: "unknown", message: "The response did not include its link." } : r; }, (r) => setLink(r.link!))} title={neverLoggedIn ? "Get an invite link to share" : "Get a password setup link to share"}><Copy className="size-4" /> {neverLoggedIn ? "Invite link" : "Reset password"}</Button>}
        {!u.isSelf && u.status === "ACTIVE" && <Button variant="secondary" disabled={disabled} onClick={() => run("View as", () => viewAs(u.id), () => { router.push("/"); router.refresh(); })} title="Preview this person's view (read-only)"><Eye className="size-4" /> View as</Button>}
        {!u.isSelf && <Button variant="secondary" disabled={disabled} onClick={() => run(u.status === "DISABLED" ? "Restore access" : "Revoke access", () => setUserStatus(u.id, u.status === "DISABLED" ? "ACTIVE" : "DISABLED"))}>{u.status === "DISABLED" ? <><RotateCcw className="size-4" /> Restore</> : <><Ban className="size-4" /> Revoke</>}</Button>}
        {!u.isSelf && <Button variant="quiet" disabled={disabled} aria-label={`Remove ${name}`} title="Remove user" onClick={() => run("Remove account", () => removeUser(u.id))}><Trash2 className="size-4" /></Button>}
      </div>
    </div>
    {isOwner && <p className="mt-2 text-ui-status text-muted">Full access — owners see everything.</p>}
    {!isOwner && <div id={`access-${u.id}`} hidden={!expanded}><AccessToggles u={u} busy={busy} held={held} run={run} /></div>}
    {link && <CopyLink link={link} />}
    <UserReceipt receipt={receipt} userId={u.id} />
    {receipt?.outcome === "refused" && <Button variant="quiet" disabled={busy} onClick={() => router.refresh()}>Refresh account</Button>}
  </div>;
}

export function UsersManager({ users }: { users: UserView[] }) {
  return <div className="space-y-4"><AddUser /><div className="space-y-3">{users.map((u) => <UserCard key={u.id} u={u} />)}</div></div>;
}
