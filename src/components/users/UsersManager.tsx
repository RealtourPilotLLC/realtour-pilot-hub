"use client";

import { useState, useTransition } from "react";
import { UserPlus, Loader2, Copy, Check, ChevronDown, Shield, Ban, RotateCcw, Trash2, X } from "lucide-react";
import {
  ROLES, ROLE_LABEL, PAGES, roleHasByDefault, parsePermissions, canAccess, type PageKey,
} from "@/lib/auth/access";
import { inviteUser, inviteLinkFor, setUserRole, setUserPermission, setUserStatus, removeUser } from "@/app/users/actions";

export type UserView = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  permissions: string | null;
  status: string;
  lastLoginAt: string | null;
  isSelf: boolean;
};

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: "bg-success/10 text-success",
  INVITED: "bg-warning/10 text-warning",
  DISABLED: "bg-danger/10 text-danger",
};

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 p-2">
      <input readOnly value={link} className="min-w-0 flex-1 bg-transparent text-xs text-muted outline-none" />
      <button
        onClick={() => { navigator.clipboard?.writeText(link).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-brand px-2 py-1 text-xs font-medium text-white hover:opacity-90"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function AddUser() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("PHOTOGRAPHER");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const submit = () => start(async () => {
    setMsg(null);
    const r = await inviteUser({ email, name, role });
    setMsg(r.message);
    if (r.ok && r.link) { setLink(r.link); setEmail(""); setName(""); }
  });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
        <UserPlus className="size-4" /> Add a user
      </button>
    );
  }
  return (
    <div className="panel-shadow rounded-2xl border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Invite someone</h3>
        <button onClick={() => { setOpen(false); setMsg(null); setLink(null); }} className="text-muted-2 hover:text-foreground"><X className="size-4" /></button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-muted-2">
          Email (their Google login)
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-2">
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="First Last" className="rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-2">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-lg border border-border bg-surface px-2 py-2 text-sm outline-none focus:border-brand">
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        <button onClick={submit} disabled={pending || !email.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />} Create invite
        </button>
      </div>
      {msg && !link && <p className="mt-2 text-xs text-muted">{msg}</p>}
      {link && (
        <div className="mt-3">
          <p className="text-xs text-success">Invite ready — send them this link. They sign in with Google using that email.</p>
          <CopyLink link={link} />
        </div>
      )}
    </div>
  );
}

function AccessToggles({ u }: { u: UserView }) {
  const [pending, start] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const toggle = (key: PageKey, next: boolean) => {
    setBusyKey(key);
    const def = roleHasByDefault(u.role, key);
    start(async () => {
      await setUserPermission(u.id, key, next === def ? null : next);
      setBusyKey(null);
    });
  };
  const reset = () => start(async () => { for (const k of Object.keys(parsePermissions(u.permissions))) await setUserPermission(u.id, k, null); });

  return (
    <div className="mt-3 rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Page access</span>
        <button onClick={reset} disabled={pending} className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"><RotateCcw className="size-3" /> Reset to {ROLE_LABEL[u.role]} defaults</button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {PAGES.filter((p) => !p.ownerOnly).map((p) => {
          const on = canAccess(u, p.key);
          const overridden = p.key in parsePermissions(u.permissions);
          return (
            <label key={p.key} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-surface-2">
              <input type="checkbox" checked={on} disabled={pending && busyKey === p.key} onChange={(e) => toggle(p.key, e.target.checked)} className="size-4 accent-[var(--brand)]" />
              <span className={on ? "text-foreground/90" : "text-muted-2"}>{p.label}</span>
              {overridden && <span className="text-[10px] text-brand">•</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function UserCard({ u }: { u: UserView }) {
  const [pending, start] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const neverLoggedIn = !u.lastLoginAt;

  const changeRole = (role: string) => start(async () => { const r = await setUserRole(u.id, role); if (!r.ok) setMsg(r.message); });
  const getLink = () => start(async () => { const r = await inviteLinkFor(u.id); if (r.ok && r.link) setLink(r.link); else setMsg(r.message); });
  const toggleStatus = () => start(async () => { const r = await setUserStatus(u.id, u.status === "DISABLED" ? "ACTIVE" : "DISABLED"); if (!r.ok) setMsg(r.message); });
  const remove = () => start(async () => { const r = await removeUser(u.id); if (!r.ok) setMsg(r.message); });

  const isOwner = u.role === "OWNER";

  return (
    <div className="panel-shadow rounded-2xl border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{u.name || u.email}</span>
            {u.isSelf && <span className="rounded bg-surface-2 px-1.5 text-[10px] text-muted-2">you</span>}
            <span className={`rounded-full px-1.5 text-[11px] font-medium ${STATUS_STYLE[u.status] ?? "bg-surface-2 text-muted"}`}>{u.status.toLowerCase()}</span>
          </div>
          <div className="truncate text-xs text-muted-2">{u.email}{u.lastLoginAt ? ` · last in ${new Date(u.lastLoginAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : " · hasn't signed in yet"}</div>
        </div>

        <select value={u.role} disabled={pending || (u.isSelf && isOwner)} onChange={(e) => changeRole(e.target.value)} title="Role" className="rounded-lg border bg-surface px-2 py-1.5 text-xs focus:outline-none disabled:opacity-60">
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>

        {!isOwner && (
          <button onClick={() => setExpanded((v) => !v)} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground">
            <Shield className="size-3.5" /> Access <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
        {neverLoggedIn && (
          <button onClick={getLink} disabled={pending} className="inline-flex items-center gap-1 rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand/20">
            <Copy className="size-3.5" /> Invite link
          </button>
        )}
        {!u.isSelf && (
          <button onClick={toggleStatus} disabled={pending} title={u.status === "DISABLED" ? "Restore access" : "Revoke access"} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground">
            {u.status === "DISABLED" ? <><RotateCcw className="size-3.5" /> Restore</> : <><Ban className="size-3.5" /> Revoke</>}
          </button>
        )}
        {!u.isSelf && (
          <button onClick={remove} disabled={pending} title="Remove user" className="flex size-8 items-center justify-center rounded-lg text-muted-2 hover:bg-danger/10 hover:text-danger">
            <Trash2 className="size-4" />
          </button>
        )}
      </div>

      {isOwner && <p className="mt-2 text-[11px] text-muted-2">Full access — owners see everything.</p>}
      {expanded && !isOwner && <AccessToggles u={u} />}
      {link && <CopyLink link={link} />}
      {msg && <p className="mt-2 text-xs text-danger">{msg}</p>}
    </div>
  );
}

export function UsersManager({ users }: { users: UserView[] }) {
  return (
    <div className="space-y-4">
      <AddUser />
      <div className="space-y-3">
        {users.map((u) => <UserCard key={u.id} u={u} />)}
      </div>
    </div>
  );
}
