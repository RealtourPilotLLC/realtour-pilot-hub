"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Mail, UserPlus, X } from "lucide-react";
import { portalCancelHeldInvite, portalInviteTeammate, portalRevokeTeammate, portalSetTeammateRole } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { Button } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { useAccessAttempt } from "./useAccessAttempt";
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

export function TeamSettings({ seats, invitationsOn }: { seats: TeamSeat[]; invitationsOn: boolean }) {
  const router = useRouter();
  const attempt = useAccessAttempt(() => `portal-team-unconfirmed:${portalAuthFromLocation().enrollmentId ?? "current-tab"}`);
  const busy = attempt.blocked;
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("OWNER");
  const draft = useRef({ name: "", email: "", role: "OWNER" });
  const run = async (operation: "invite" | "role" | "revoke" | "cancelHeld", fn: () => Promise<{ ok: boolean; message: string }>, after?: () => boolean) => {
    const id = attempt.begin(operation);
    if (!id) return;
    setNote(null);
    try {
      const r = await fn();
      const unchanged = r.ok ? after?.() : undefined;
      setNote({ ok: r.ok, text: r.message + (unchanged === false ? " Your newer invitation draft has been kept." : "") });
      attempt.finish(id, true); // These returned refusals precede the domain writes.
      if (r.ok) router.refresh();
    } catch { attempt.finish(id, false); }
  };
  function invite() {
    const sent = { ...draft.current };
    if (sent.name.trim().length < 2 || !sent.email.trim()) return;
    void run("invite", () => portalInviteTeammate(auth(), sent), () => {
      const current = draft.current;
      if (current.name !== sent.name || current.email !== sent.email || current.role !== sent.role) return false;
      draft.current = { name: "", email: "", role: "OWNER" };
      setName(""); setEmail(""); setRole("OWNER");
      return true;
    });
  }
  const auth = () => portalAuthFromLocation();

  return (
    <div className="mt-2 space-y-3">
      {!invitationsOn && (
        <p className="flex items-start gap-2 rounded-xl border border-border bg-surface-2/50 p-3 text-sm text-muted">
          <Clock className="mt-0.5 size-3.5 shrink-0" />
          {/* Neutral (review fix, Sep 28 2026): invitationsOn is per client
              now (the switch AND the program rollout), so "the moment we
              switch invitations on" was untrue for a client the rollout holds. */}
          Invitations aren&rsquo;t being sent yet for your account. Anyone you add here is saved on your account, and we&rsquo;ll email their sign-in as soon as your account is set up for it. Nothing goes to them before that.
        </p>
      )}

      <ul className="divide-y divide-border rounded-xl border border-border">
        {seats.map((s) => (
          <li key={s.seatKey} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{s.name || s.email}{s.isYou && <span className="ml-1.5 text-sm font-normal text-muted-2">(you)</span>}</div>
              {s.name && <div className="break-words text-sm text-muted">{s.email}</div>}
              <div className="mt-0.5 flex flex-wrap gap-1.5 text-sm">
                <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-medium text-muted">{roleLabel(s.role)}</span>
                {s.held ? (
                  <span className="rounded-md bg-warning-soft px-1.5 py-0.5 font-medium text-warning">Held — we&rsquo;ll send their sign-in when invitations open</span>
                ) : s.pending ? (
                  <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-medium text-brand">Invited — hasn&rsquo;t signed in yet</span>
                ) : null}
              </div>
            </div>
            {s.held ? (
              <Button variant="secondary" disabled={busy} onClick={() => run("cancelHeld", () => portalCancelHeldInvite(auth(), s.email))} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-sm text-muted hover:text-danger disabled:opacity-50">
                <X className="size-3" /> Cancel invitation
              </Button>
            ) : !s.isYou && s.membershipId && s.accountHolder ? (
              <span className="text-sm text-muted-2">Account holder</span>
            ) : !s.isYou && s.membershipId ? (
              <div className="flex items-center gap-1.5">
                <select
                  aria-label={`What ${s.name || s.email} can do`} value={s.role} disabled={busy}
                  onChange={(e) => { const next = e.target.value; const id = s.membershipId!; run("role", () => portalSetTeammateRole(auth(), id, next)); }}
                  className="min-h-11 max-w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
                <Button variant="secondary"
                  disabled={busy}
                  onClick={() => { if (window.confirm(`Remove ${s.name || s.email}? They lose access straight away.`)) { const id = s.membershipId!; run("revoke", () => portalRevokeTeammate(auth(), id)); } }}
                  className="rounded-lg border border-border px-2.5 py-1 text-sm text-muted hover:text-danger disabled:opacity-50"
                >
                  Remove
                </Button>
              </div>
            ) : null}
          </li>
        ))}
        {seats.length === 0 && <li className="px-3 py-2.5 text-sm text-muted">Nobody else is on this account yet.</li>}
      </ul>

      <div className="rounded-xl border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-semibold"><UserPlus className="size-4 text-brand" /> Add an assistant or teammate</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <TextField id="team-invite-name" name="teammateName" label="Their name" value={name} onChange={(e) => { draft.current.name = e.target.value; setName(e.target.value); }} placeholder="First and last name" autoComplete="off" />
          <TextField id="team-invite-email" name="teammateEmail" label="Their email" value={email} onChange={(e) => { draft.current.email = e.target.value; setEmail(e.target.value); }} type="email" placeholder="name@example.com" autoComplete="off" />
        </div>
        <fieldset className="mt-2 space-y-1">
          <legend className="text-sm text-muted">What they can do</legend>
          {ROLES.map((r) => (
            <label key={r.key} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg p-2 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand">
              <input type="radio" name="team-role" value={r.key} checked={role === r.key} onChange={() => { draft.current.role = r.key; setRole(r.key); }} className="mt-1 accent-[var(--brand)]" />
              <span><span className="font-medium">{r.label}</span> <span className="text-sm text-muted">— {r.detail}</span></span>
            </label>
          ))}
        </fieldset>
        <Button variant="primary"
          busy={attempt.pending}
          disabled={busy || name.trim().length < 2 || !email.trim()}
          onClick={invite}
          className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-brand-action px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          <Mail className="size-4" /> {invitationsOn ? "Send invitation" : "Save — invite later"}
        </Button>
      </div>

      {attempt.held && <div role="alert" className="space-y-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm leading-relaxed">
        <p>This access change is unconfirmed. It may already have been saved or sent. Reply to any text or email from us and ask our team to check the account’s access and invitation history before repeating it.</p>
        <p>This tab holds further access changes. Reloading does not prove the earlier request ended. New input is kept only while this form stays open.</p>
      </div>}
      {attempt.localError && <p role="alert" className="text-sm text-danger">{attempt.localError}</p>}
      {note && <p role={note.ok ? "status" : "alert"} className={note.ok ? "text-sm leading-relaxed text-success" : "text-sm leading-relaxed text-danger"}>{note.text}</p>}
    </div>
  );
}
