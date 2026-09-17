"use client";

import { useState, useTransition } from "react";
import { Copy, ExternalLink, Loader2, RefreshCw, TimerOff, UserMinus, UserPlus, Link2, Eye } from "lucide-react";
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
  const [msg, setMsg] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{ url: string; expiresAtISO: string } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("OWNER");
  const [days, setDays] = useState("30");
  const [busy, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "That didn't go through — try again." }));
      setMsg(r.message);
    });
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => setMsg("Copied.")).catch(() => setMsg("Couldn't copy — select it by hand."));

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
            <span className="text-xs text-muted">not issued</span>
          ) : link.expired ? (
            <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold text-danger">expired</span>
          ) : (
            <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">live</span>
          )}
          {props.accessRevokedAtISO && <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold text-danger">access revoked {fmt(props.accessRevokedAtISO)}</span>}
        </div>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted">
          <dt>Issued</dt><dd>{fmt(link.issuedAtISO) ?? (link.issued ? "before Sep 16 (no stamp)" : "—")}</dd>
          <dt>Expires</dt><dd>{fmt(link.expiresAtISO) ?? "never"}</dd>
          <dt>Rotated</dt><dd>{fmt(link.rotatedAtISO) ?? "never"}</dd>
          <dt>Last opened</dt>
          <dd>{lastOpened ? `${fmt(lastOpened.atISO)} · ${lastOpened.via.toLowerCase()}${lastOpened.who ? ` · ${lastOpened.who}` : ""} · ${visits} visit${visits === 1 ? "" : "s"} total` : "never"}</dd>
        </dl>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {link.url && (
            <>
              <button disabled={busy} onClick={() => copy(link.url!)} className={btn}><Copy className="size-3.5" /> Copy link</button>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className={btn}><ExternalLink className="size-3.5" /> Open</a>
            </>
          )}
          <button disabled={busy} onClick={() => run(() => rotatePortalLink(enrollmentId))} className={btn}>
            <RefreshCw className="size-3.5" /> {link.issued ? "Rotate" : "Create link"}
          </button>
          {link.issued && (
            <span className="inline-flex items-center gap-1">
              <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className="w-14 rounded-lg border border-border bg-surface px-2 py-1 text-xs" aria-label="Days until the link expires" />
              <button disabled={busy} onClick={() => run(() => expirePortalLink(enrollmentId, Math.max(0, parseInt(days, 10) || 0)))} className={btn}>
                <TimerOff className="size-3.5" /> {parseInt(days, 10) === 0 ? "Expire now" : "Expire in days"}
              </button>
              {link.expiresAtISO && <button disabled={busy} onClick={() => run(() => expirePortalLink(enrollmentId, null))} className={btn}>Never expire</button>}
            </span>
          )}
        </div>
      </div>

      {/* PEOPLE */}
      <div>
        <div className="flex items-center gap-2 font-semibold"><Eye className="size-4 text-brand" /> People with access</div>
        {active.length === 0 ? (
          <p className="mt-1 text-xs text-muted">Nobody has a personal sign-in yet — the share link is the only door.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {active.map((p) => (
              <li key={p.membershipId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name ?? p.email}</div>
                  <div className="truncate text-xs text-muted">{p.email} · invited {fmt(p.invitedAtISO)}{p.acceptedAtISO ? ` · accepted ${fmt(p.acceptedAtISO)}` : " · not signed in yet"}{p.lastLoginAtISO ? ` · last sign-in ${fmt(p.lastLoginAtISO)}` : ""}</div>
                </div>
                <select value={p.role} disabled={busy} onChange={(e) => run(() => setPortalPersonRole(enrollmentId, p.membershipId, e.target.value))}
                  className="rounded-lg border border-border bg-surface px-2 py-1 text-xs" title={ROLE_HELP[p.role]}>
                  {ROLES.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
                </select>
                <button disabled={busy} title="Mint a one-time sign-in link to open yourself (testing)"
                  onClick={() => start(async () => {
                    const r = await getPortalSignInLink(enrollmentId, p.membershipId).catch(() => ({ ok: false, message: "That didn't go through." } as { ok: boolean; message: string; url?: string; expiresAtISO?: string }));
                    setMsg(r.message);
                    setSignIn(r.ok && r.url && r.expiresAtISO ? { url: r.url, expiresAtISO: r.expiresAtISO } : null);
                  })}
                  className={btn}>Get sign-in link</button>
                <button disabled={busy} onClick={() => run(() => revokePortalPerson(enrollmentId, p.membershipId))} className={cn(btn, "text-danger")}>
                  <UserMinus className="size-3.5" /> Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        {signIn && (
          <div className="mt-2 rounded-xl border border-brand/30 bg-brand-soft/30 p-3 text-xs">
            <div className="font-semibold">One-time sign-in link (expires {fmt(signIn.expiresAtISO)}) — open it yourself to test; nothing was emailed.</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate">{signIn.url}</code>
              <button onClick={() => copy(signIn.url)} className={btn}><Copy className="size-3.5" /> Copy</button>
            </div>
          </div>
        )}
        {revoked.length > 0 && (
          <details className="mt-2 text-xs text-muted">
            <summary className="cursor-pointer">{revoked.length} revoked</summary>
            <ul className="mt-1 space-y-0.5">
              {revoked.map((p) => <li key={p.membershipId}>{p.name ?? p.email} · {p.email} · revoked {fmt(p.revokedAtISO)}</li>)}
            </ul>
          </details>
        )}

        {/* INVITE */}
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await invitePortalPerson(enrollmentId, email, name, role); if (r.ok) { setEmail(""); setName(""); } return r; }); }}
        >
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Email</span>
            <input type="email" required disabled={inviteBlocked} value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 block w-52 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs disabled:opacity-50" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Name</span>
            <input disabled={inviteBlocked} value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-40 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs disabled:opacity-50" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Role</span>
            <select disabled={inviteBlocked} value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])} className="mt-1 block rounded-lg border border-border bg-surface px-2 py-1.5 text-xs disabled:opacity-50" title={ROLE_HELP[role]}>
              {ROLES.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
            </select>
          </label>
          <button type="submit" disabled={busy || inviteBlocked} className={cn(btn, "bg-brand text-white hover:opacity-90 disabled:opacity-50")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />} {switches.invites ? "Invite" : "Add person"}
          </button>
        </form>
        <p className={cn("mt-1.5 text-[11px]", inviteBlocked ? "text-warning" : "text-muted")}>{inviteNote}</p>
        {!switches.loginEmail && (
          <p className="mt-1 text-[11px] text-muted">Sign-in emails are switched off until launch: a person who asks for a link on the sign-in page gets the &ldquo;check your inbox&rdquo; message and nothing is sent. &ldquo;Get sign-in link&rdquo; above is the test path{isTestClient ? "" : " (TEST clients only)"}.</p>
        )}
      </div>

      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}

const btn = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50";
