"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock, Loader2, Mail, UserPlus, X } from "lucide-react";
import { portalCancelHeldInvite, portalInviteTeammate, portalRevokeTeammate, portalSetTeammateRole } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { TeamSeat } from "@/lib/portalTeam";

// ---------------------------------------------------------------------------
// The team list and the invite form (CP-06). Every button calls the existing
// membership actions (src/app/portal/actions.ts → src/lib/portalTeam.ts), which
// re-check the permission and the enrollment on the server; this component
// only decides what to show. An assistant gets FULL access by default — the
// owner seat, as Jordan asked — and the choice below says what each seat means.
// ---------------------------------------------------------------------------

const ROLES = [
  { key: "OWNER", label: "Full access", detail: "Everything you can do, including approving videos" },
  { key: "COLLABORATOR", label: "Collaborator", detail: "Can plan, comment and request changes — you keep the approvals" },
  { key: "VIEWER", label: "View only", detail: "Can watch and download, nothing else" },
] as const;
const roleLabel = (r: string) => ROLES.find((x) => x.key === r)?.label ?? r;
const field = "w-full rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-sm outline-none focus:border-brand";

export function TeamSettings({ seats, invitationsOn }: { seats: TeamSeat[]; invitationsOn: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("OWNER");
  const run = (fn: () => Promise<{ ok: boolean; message: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "That didn't go through — try again." }));
      setNote({ ok: r.ok, text: r.message });
      if (r.ok) { after?.(); router.refresh(); }
    });
  const auth = () => portalAuthFromLocation();

  return (
    <div className="mt-2 space-y-3">
      {!invitationsOn && (
        <p className="flex items-start gap-2 rounded-xl border border-border bg-surface-2/50 p-3 text-xs text-muted">
          <Clock className="mt-0.5 size-3.5 shrink-0" />
          Invitations aren&rsquo;t being sent yet. Anyone you add here is saved on your account, and we&rsquo;ll email their sign-in the moment we switch invitations on. Nothing goes to them before that.
        </p>
      )}

      <ul className="divide-y divide-border rounded-xl border border-border">
        {seats.map((s) => (
          <li key={s.seatKey} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{s.name || s.email}{s.isYou && <span className="ml-1.5 text-xs font-normal text-muted-2">(you)</span>}</div>
              {s.name && <div className="truncate text-xs text-muted">{s.email}</div>}
              <div className="mt-0.5 flex flex-wrap gap-1.5 text-[11px]">
                <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-medium text-muted">{roleLabel(s.role)}</span>
                {s.held ? (
                  <span className="rounded-md bg-warning-soft px-1.5 py-0.5 font-medium text-warning">Held — we&rsquo;ll send their sign-in when invitations open</span>
                ) : s.pending ? (
                  <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-medium text-brand">Invited — hasn&rsquo;t signed in yet</span>
                ) : null}
              </div>
            </div>
            {s.held ? (
              <button disabled={busy} onClick={() => run(() => portalCancelHeldInvite(auth(), s.email))} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:text-danger disabled:opacity-50">
                <X className="size-3" /> Cancel invitation
              </button>
            ) : !s.isYou && s.membershipId && s.accountHolder ? (
              <span className="text-[11px] text-muted-2">Account holder</span>
            ) : !s.isYou && s.membershipId ? (
              <div className="flex items-center gap-1.5">
                <select
                  aria-label={`What ${s.name || s.email} can do`} value={s.role} disabled={busy}
                  onChange={(e) => { const next = e.target.value; const id = s.membershipId!; run(() => portalSetTeammateRole(auth(), id, next)); }}
                  className="rounded-lg border border-border bg-surface-2/60 px-2 py-1 text-xs"
                >
                  {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
                <button
                  disabled={busy}
                  onClick={() => { if (window.confirm(`Remove ${s.name || s.email}? They lose access straight away.`)) { const id = s.membershipId!; run(() => portalRevokeTeammate(auth(), id)); } }}
                  className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:text-danger disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            ) : null}
          </li>
        ))}
        {seats.length === 0 && <li className="px-3 py-2.5 text-sm text-muted">Nobody else is on this account yet.</li>}
      </ul>

      <div className="rounded-xl border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-semibold"><UserPlus className="size-4 text-brand" /> Add an assistant or teammate</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-muted">Their name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="First and last name" className={`mt-1 ${field}`} autoComplete="off" />
          </label>
          <label className="text-xs text-muted">Their email
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="name@example.com" className={`mt-1 ${field}`} autoComplete="off" />
          </label>
        </div>
        <fieldset className="mt-2 space-y-1">
          <legend className="text-xs text-muted">What they can do</legend>
          {ROLES.map((r) => (
            <label key={r.key} className="flex items-start gap-2 text-sm">
              <input type="radio" name="team-role" value={r.key} checked={role === r.key} onChange={() => setRole(r.key)} className="mt-1 accent-[var(--brand)]" />
              <span><span className="font-medium">{r.label}</span> <span className="text-xs text-muted">— {r.detail}</span></span>
            </label>
          ))}
        </fieldset>
        <button
          disabled={busy || name.trim().length < 2 || !email.trim()}
          onClick={() => run(() => portalInviteTeammate(auth(), { name, email, role }), () => { setName(""); setEmail(""); setRole("OWNER"); })}
          className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />} {invitationsOn ? "Send invitation" : "Save — invite later"}
        </button>
      </div>

      {note && <p className={note.ok ? "text-xs text-success" : "text-xs text-danger"}>{note.text}</p>}
    </div>
  );
}
