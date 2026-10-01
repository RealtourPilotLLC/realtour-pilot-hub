"use client";

import { useRef, useState } from "react";
import { ExternalLink, RefreshCw, TimerOff, UserMinus, UserPlus, Link2, Eye } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { TextField, FormField } from "@/components/ui/FormField";
import { CopyButton } from "@/components/ui/CopyButton";
import { useAccessAttempt } from "../useAccessAttempt";
import { cn } from "@/lib/utils";
import {
  rotatePortalLink, expirePortalLink, invitePortalPerson, revokePortalPerson, setPortalPersonRole, getPortalSignInLink,
} from "@/app/content/portalAccessActions";

// The interactive half of the owner's "Portal access" card. Plain data in,
// server actions out — no prisma, no settings, nothing server-only (the
// Turbopack rule). Every launch gate is enforced by the actions; the copy
// here only explains why a button is off.

type Person = {
  membershipId: string; email: string; name: string | null; role: "OWNER" | "COLLABORATOR" | "VIEWER";
  invitedAtISO: string; acceptedAtISO: string | null; revokedAtISO: string | null; lastLoginAtISO: string | null;
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);
const ROLES = ["OWNER", "COLLABORATOR", "VIEWER"] as const;
const ROLE_HELP: Record<(typeof ROLES)[number], string> = {
  OWNER: "approves edits, requests changes, edits the brand profile, connects accounts",
  COLLABORATOR: "requests changes, comments, suggests, books — cannot approve or change the brand",
  VIEWER: "watches only",
};

export function PortalAccessControls(props: {
  enrollmentId: string;
  clientName: string;
  isTestClient: boolean;
  status: string;
  link: { issued: boolean; url: string | null; issuedAtISO: string | null; expiresAtISO: string | null; rotatedAtISO: string | null; expired: boolean };
  accessRevokedAtISO: string | null;
  people: Person[];
  lastOpened: { atISO: string; via: string; who: string | null } | null;
  visits: number;
  switches: { invites: boolean; loginEmail: boolean };
}) {
  const { enrollmentId, link, people, lastOpened, visits, switches, isTestClient } = props;
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [signIn, setSignIn] = useState<{ url: string; expiresAtISO: string; who: string } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("OWNER");
  const [days, setDays] = useState("30");
  const attempt = useAccessAttempt(`staff-portal-unconfirmed:${enrollmentId}`);
  const busy = attempt.blocked;
  const draft = useRef({ name: "", email: "", role: "OWNER" as (typeof ROLES)[number] });
  type AccessResult = { ok: boolean; message: string; outcome?: "confirmed" | "refused" | "unknown"; url?: string; expiresAtISO?: string };
  const run = async (operation: "invite" | "role" | "revoke" | "rotate" | "expire" | "mint", fn: () => Promise<AccessResult>, after?: (r: AccessResult) => boolean) => {
    const id = attempt.begin(operation);
    if (!id) return;
    setMsg(null);
    if (operation === "mint") setSignIn(null);
    try {
      const r = await fn();
      const confirmed = r.ok && r.outcome === "confirmed";
      const known = confirmed || (!r.ok && r.outcome === "refused");
      const unchanged = confirmed ? after?.(r) : undefined;
      setMsg({ ok: confirmed, text: r.message + (unchanged === false ? " Your newer invitation draft has been kept." : "") });
      attempt.finish(id, known);
    } catch { attempt.finish(id, false); }
  };
  function invite() {
    if (inviteBlocked) return;
    const sent = { ...draft.current };
    void run("invite", () => invitePortalPerson(enrollmentId, sent.email, sent.name, sent.role), () => {
      const current = draft.current;
      if (current.email !== sent.email || current.name !== sent.name || current.role !== sent.role) return false;
      draft.current = { ...sent, email: "", name: "" }; setEmail(""); setName("");
      return true;
    });
  }

  // Invitations while the switch is off: only a TEST client can be given a
  // person, and only on a staff-controlled address. The action refuses
  // regardless; this is the explanation.
  const inviteBlocked = !switches.invites && !isTestClient;
  const inviteNote = switches.invites
    ? "An invitation email goes out through the outbox."
    : isTestClient
      ? "TEST client: the seat is created, nothing is emailed (invitations are switched off until launch). Use a staff-controlled @realtourpilot.com address."
      : "Invitations are switched off until launch is authorised — no seat can be created for a real client yet.";
  const active = people.filter((p) => !p.revokedAtISO);
  const revoked = people.filter((p) => p.revokedAtISO);

  return (
    <div className="space-y-5 text-sm">
      {/* THE LINK */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Link2 className="size-4 text-brand" />
          <span className="font-semibold">Share link</span>
          {!link.issued ? (
            <span className="text-sm text-muted">not issued</span>
          ) : link.expired ? (
            <span className="rounded bg-danger-soft px-1.5 py-0.5 text-sm font-semibold text-danger">expired</span>
          ) : (
            <span className="rounded bg-success-soft px-1.5 py-0.5 text-sm font-semibold text-success">live</span>
          )}
          {props.accessRevokedAtISO && <span className="rounded bg-danger-soft px-1.5 py-0.5 text-sm font-semibold text-danger">access revoked {fmt(props.accessRevokedAtISO)}</span>}
        </div>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm text-muted">
          <dt>Issued</dt><dd>{fmt(link.issuedAtISO) ?? (link.issued ? "before Sep 16 (no stamp)" : "—")}</dd>
          <dt>Expires</dt><dd>{fmt(link.expiresAtISO) ?? "never"}</dd>
          <dt>Rotated</dt><dd>{fmt(link.rotatedAtISO) ?? "never"}</dd>
          <dt>Last opened</dt>
          <dd>{lastOpened ? `${fmt(lastOpened.atISO)} · ${lastOpened.via.toLowerCase()}${lastOpened.who ? ` · ${lastOpened.who}` : ""} · ${visits} visit${visits === 1 ? "" : "s"} total` : "never"}</dd>
        </dl>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {link.url && (
            <>
              <CopyButton value={link.url} label="Copy link" />
              <a href={link.url} target="_blank" rel="noopener noreferrer" className={btn}><ExternalLink className="size-3.5" /> Open</a>
            </>
          )}
          <Button variant="secondary" disabled={busy} onClick={() => run("rotate", () => rotatePortalLink(enrollmentId))} className={btn}>
            <RefreshCw className="size-3.5" /> {link.issued ? "Rotate" : "Create link"}
          </Button>
          {link.issued && (
            <span className="inline-flex flex-wrap items-center gap-2">
              <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className="min-h-11 w-20 rounded-lg border border-border-strong bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" aria-label="Days until the link expires" />
              <Button variant="secondary" disabled={busy} onClick={() => run("expire", () => expirePortalLink(enrollmentId, Math.max(0, parseInt(days, 10) || 0)))} className={btn}>
                <TimerOff className="size-3.5" /> {parseInt(days, 10) === 0 ? "Expire now" : "Expire in days"}
              </Button>
              {link.expiresAtISO && <Button variant="secondary" disabled={busy} onClick={() => run("expire", () => expirePortalLink(enrollmentId, null))} className={btn}>Never expire</Button>}
            </span>
          )}
        </div>
      </div>

      {/* PEOPLE */}
      <div>
        <div className="flex items-center gap-2 font-semibold"><Eye className="size-4 text-brand" /> People with access</div>
        {active.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Nobody has a personal sign-in yet — the share link is the only door.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {active.map((p) => (
              <li key={p.membershipId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="break-words font-medium">{p.name ?? p.email}</div>
                  <div className="break-words text-sm text-muted">{p.email} · invited {fmt(p.invitedAtISO)}{p.acceptedAtISO ? ` · accepted ${fmt(p.acceptedAtISO)}` : " · not signed in yet"}{p.lastLoginAtISO ? ` · last sign-in ${fmt(p.lastLoginAtISO)}` : ""}</div>
                </div>
                <select value={p.role} disabled={busy} onChange={(e) => { const next = e.target.value; void run("role", () => setPortalPersonRole(enrollmentId, p.membershipId, next)); }}
                  className={selectClass} aria-label={`Role for ${p.name ?? p.email}`} title={ROLE_HELP[p.role]}>
                  {ROLES.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
                </select>
                <Button variant="secondary" disabled={busy} title="Mint a one-time sign-in link to open yourself (testing)"
                  onClick={() => run("mint", () => getPortalSignInLink(enrollmentId, p.membershipId), (r) => {
                    if (r.url && r.expiresAtISO) setSignIn({ url: r.url, expiresAtISO: r.expiresAtISO, who: p.name ?? p.email });
                    return true;
                  })}
                  className={btn}>Get sign-in link</Button>
                <Button variant="secondary" disabled={busy} onClick={() => run("revoke", () => revokePortalPerson(enrollmentId, p.membershipId))} className={cn(btn, "text-danger")}>
                  <UserMinus className="size-3.5" /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {signIn && (
          <div className="mt-2 rounded-xl border border-brand/30 bg-brand-soft/30 p-3 text-sm">
            <div className="font-semibold">One-time sign-in link for {signIn.who} (expires {fmt(signIn.expiresAtISO)}) — open it yourself to test; nothing was emailed.</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-words">{signIn.url}</code>
              <CopyButton value={signIn.url} label="Copy sign-in link" />
            </div>
          </div>
        )}
        {revoked.length > 0 && (
          <details className="mt-2 text-sm text-muted">
            <summary className="min-h-11 cursor-pointer rounded-lg py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{revoked.length} revoked</summary>
            <ul className="mt-1 space-y-0.5">
              {revoked.map((p) => <li key={p.membershipId}>{p.name ?? p.email} · {p.email} · revoked {fmt(p.revokedAtISO)}</li>)}
            </ul>
          </details>
        )}

        {/* INVITE */}
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); invite(); }}
        >
          <TextField id={`staff-invite-email-${enrollmentId}`} name="email" label="Email" type="email" required disabled={inviteBlocked} value={email}
            onChange={(e) => { draft.current.email = e.target.value; setEmail(e.target.value); }} className="w-full sm:w-64" />
          <TextField id={`staff-invite-name-${enrollmentId}`} name="name" label="Name" disabled={inviteBlocked} value={name}
            onChange={(e) => { draft.current.name = e.target.value; setName(e.target.value); }} className="w-full sm:w-52" />
          <FormField id={`staff-invite-role-${enrollmentId}`} label="Role">
            <select id={`staff-invite-role-${enrollmentId}`} name="role" disabled={inviteBlocked} value={role}
              onChange={(e) => { const next = e.target.value as (typeof ROLES)[number]; draft.current.role = next; setRole(next); }} className={selectClass} title={ROLE_HELP[role]}>
              {ROLES.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
            </select>
          </FormField>
          <Button variant="secondary" type="submit" busy={attempt.pending} disabled={busy || inviteBlocked} className={cn(btn, "bg-brand-action text-white hover:opacity-90 disabled:opacity-50")}>
            <UserPlus className="size-4" /> {switches.invites ? "Invite" : "Add person"}
          </Button>
        </form>
        <p className={cn("mt-1.5 text-sm", inviteBlocked ? "text-warning" : "text-muted")}>{inviteNote}</p>
        {!switches.loginEmail && (
          <p className="mt-1 text-sm text-muted">Sign-in emails are switched off until launch: the sign-in page explains the switch and directs people to our team for help. &ldquo;Get sign-in link&rdquo; above is the test path{isTestClient ? "" : " (TEST clients only)"}.</p>
        )}
      </div>

      {attempt.held && <div role="alert" className="space-y-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm leading-relaxed">
        <p>This portal access change is unconfirmed. A seat, link or invitation may already have changed. Ask Kyle to inspect this client’s portal access, request logs and outbox before repeating the operation.</p>
        <p>This tab holds further access changes. Reloading does not prove the earlier writer or send ended. Native input is kept only while this form stays open.</p>
      </div>}
      {attempt.localError && <p role="alert" className="text-sm text-danger">{attempt.localError}</p>}
      {msg && <p role={msg.ok ? "status" : "alert"} className={cn("text-sm leading-relaxed", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

const btn = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-xl border border-border-strong px-3 py-2 text-sm font-medium text-foreground whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const selectClass = "min-h-11 max-w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
