"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import type { ProgramEmailsState } from "@/lib/portalAccess";
import {
  addAlsoEmailAction, changeSeatEmailAction, removeAlsoEmailAction, resendWelcomeAction, type EmailsActionResult,
} from "@/app/content/emailActions";

// ---------------------------------------------------------------------------
// PROGRAM EMAILS (Oct 21 2026), the owner's card on /content/<id> → Settings,
// under Portal access. Jordan: "add a second email to her content program
// account so we can email her on both emails and add a way for me to do that
// ... her Fox and Roach email should be the one with access to her account.
// We should resend the onboarding email to her."
//
//   Signs in with   each live seat's address and role, whether they have
//                   signed in, and "Change sign-in email".
//   Also email      extra addresses that get a copy of every email we send
//                   this client (never a sign-in link: see
//                   lib/clientEmailMonitor planAlsoEmail).
//   Welcome email   when it last went and to whom, why it is held if it is,
//                   and "Resend the welcome email" behind an in-page confirm.
//
// Plain data in, server actions out (app/content/emailActions.ts, owner only;
// "view as" is refused there). Every action answers the fresh state.
// ---------------------------------------------------------------------------

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
const ROLE_WORD: Record<string, string> = { OWNER: "Owner", COLLABORATOR: "Collaborator", VIEWER: "Viewer" };
const STATE_WORD: Record<string, string> = {
  accepted: "Sent", pending: "Sending", attempting: "Sending", unknown: "May have gone (held for a person to confirm)", failed: "Did not send",
};

export function ProgramEmailsCard({ enrollmentId, initial, canEdit = true }: { enrollmentId: string; initial: ProgramEmailsState | null; canEdit?: boolean }) {
  const [state, setState] = useState<ProgramEmailsState | null>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [seatDraft, setSeatDraft] = useState("");
  const [alsoDraft, setAlsoDraft] = useState("");
  const [confirming, setConfirming] = useState(false);

  if (!state) {
    return (
      <Section icon={Mail} title="Program emails">
        <p className="text-sm text-warning">Couldn&rsquo;t load this client&rsquo;s emails. Refresh to try again.</p>
      </Section>
    );
  }

  async function run(key: string, fn: () => Promise<EmailsActionResult>, after?: (r: EmailsActionResult) => void) {
    if (busy) return;
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      if (r.state) setState(r.state);
      setMsg({ ok: r.ok, text: r.message });
      after?.(r);
    } catch {
      setMsg({ ok: false, text: "That didn't go through. Refresh and try again." });
    } finally {
      setBusy(null);
    }
  }

  const { seats, alsoEmails, welcome } = state;
  const copyLine = alsoEmails.length ? `, with a copy to ${alsoEmails.join(", ")}` : "";

  return (
    <Section icon={Mail} title="Program emails">
      <div className="space-y-6">
        <p className="text-sm leading-relaxed text-muted">
          Who signs in to {state.clientName || "this client"}&rsquo;s portal, who else gets a copy of their emails, and their welcome email.
        </p>

        {/* ---- Signs in with ---- */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Signs in with</h3>
          {seats.length === 0 ? (
            <p className="text-sm text-muted">No one signs in to this portal yet. Invite them in Portal access.</p>
          ) : (
            <ul className="space-y-2">
              {seats.map((s) => (
                <li key={s.membershipId} className="rounded-xl border px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 break-all font-medium text-foreground">{s.email}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">{ROLE_WORD[s.role] ?? s.role}</span>
                    {s.disabled && <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">Disabled</span>}
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {s.name ? `${s.name} · ` : ""}
                    {s.signedIn ? (s.lastLoginAtISO ? `Last signed in ${fmt(s.lastLoginAtISO)}` : "Has signed in") : "Hasn't signed in yet"}
                  </p>
                  {canEdit && editing !== s.membershipId && (
                    <div className="mt-2">
                      <Button variant="secondary" disabled={!!busy} onClick={() => { setEditing(s.membershipId); setSeatDraft(""); setMsg(null); }}>
                        Change sign-in email
                      </Button>
                    </div>
                  )}
                  {canEdit && editing === s.membershipId && (
                    <form
                      className="mt-3 space-y-2"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        const email = seatDraft.trim();
                        if (!email) return;
                        void run(`seat:${s.membershipId}`, () => changeSeatEmailAction(enrollmentId, s.membershipId, email), (r) => { if (r.ok) { setEditing(null); setSeatDraft(""); } });
                      }}
                    >
                      <TextField
                        id={`seat-email-${s.membershipId}`}
                        label="New sign-in email"
                        type="email"
                        autoComplete="off"
                        inputMode="email"
                        value={seatDraft}
                        onChange={(ev) => setSeatDraft(ev.target.value)}
                        hint="Sign-in links go only to this address. Their access and history stay, any unused sign-in link stops working, and anyone already signed in stays signed in."
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" busy={busy === `seat:${s.membershipId}`} busyLabel="Saving" disabled={!seatDraft.trim() || (!!busy && busy !== `seat:${s.membershipId}`)}>
                          Save sign-in email
                        </Button>
                        <Button variant="quiet" disabled={!!busy} onClick={() => { setEditing(null); setSeatDraft(""); }}>Cancel</Button>
                      </div>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ---- Also email ---- */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Also email</h3>
          <p className="text-sm leading-relaxed text-muted">
            These addresses get a copy of every email we send this client. A sign-in link is never copied: an email that carries one reaches them as a separate copy that opens the sign-in page instead.
          </p>
          {alsoEmails.length === 0 ? (
            <p className="text-sm text-muted">No extra addresses.</p>
          ) : (
            <ul className="space-y-2">
              {alsoEmails.map((a) => (
                <li key={a} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-2">
                  <span className="min-w-0 break-all text-foreground">{a}</span>
                  {canEdit && (
                    <Button variant="quiet" aria-label={`Remove ${a}`} busy={busy === `remove:${a}`} busyLabel="Removing" disabled={!!busy && busy !== `remove:${a}`}
                      onClick={() => void run(`remove:${a}`, () => removeAlsoEmailAction(enrollmentId, a))}>
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                const email = alsoDraft.trim();
                if (!email) return;
                void run("add", () => addAlsoEmailAction(enrollmentId, email), (r) => { if (r.ok) setAlsoDraft(""); });
              }}
            >
              <TextField
                id={`also-email-${enrollmentId}`}
                label="Add an address"
                type="email"
                autoComplete="off"
                inputMode="email"
                className="min-w-[14rem] flex-1"
                value={alsoDraft}
                onChange={(ev) => setAlsoDraft(ev.target.value)}
              />
              <Button type="submit" variant="secondary" busy={busy === "add"} busyLabel="Adding" disabled={!alsoDraft.trim() || (!!busy && busy !== "add")}>Add</Button>
            </form>
          )}
        </div>

        {/* ---- Welcome email ---- */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Welcome email</h3>
          {welcome.sent.length === 0 ? (
            <p className="text-sm text-muted">No welcome on record yet.</p>
          ) : (
            <ul className="space-y-1 text-sm text-muted">
              {welcome.sent.map((w, i) => (
                <li key={`${w.atISO}-${i}`} className="break-words">
                  {STATE_WORD[w.state] ?? w.state} {fmt(w.atISO)} to <span className="break-all text-foreground">{w.to}</span>{w.resend ? " (resent)" : ""}
                </li>
              ))}
            </ul>
          )}
          {!welcome.gate.ok && <p className="text-sm text-warning">{welcome.gate.why}</p>}
          {canEdit && welcome.to && welcome.gate.ok && !confirming && (
            <Button variant="secondary" disabled={!!busy} onClick={() => { setConfirming(true); setMsg(null); }}>
              Resend the welcome email
            </Button>
          )}
          {canEdit && welcome.to && confirming && (
            <div className="space-y-3 rounded-xl border border-border-strong bg-surface-2 px-4 py-3" role="group" aria-label="Confirm the welcome email">
              <p className="text-sm text-foreground">
                Send the welcome email again to <span className="break-all font-medium">{welcome.to.email}</span>{copyLine}?
              </p>
              <div className="flex flex-wrap gap-2">
                <Button busy={busy === "resend"} busyLabel="Sending" disabled={!!busy && busy !== "resend"}
                  onClick={() => void run("resend", () => resendWelcomeAction(enrollmentId), () => setConfirming(false))}>
                  Yes, send it
                </Button>
                <Button variant="quiet" disabled={!!busy} onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>

        {!canEdit && <p className="text-sm text-muted">Read-only while previewing.</p>}
        <p role="status" aria-live="polite" className={msg ? (msg.ok ? "text-sm font-medium text-success" : "text-sm font-medium text-danger") : "sr-only"}>
          {msg?.text ?? ""}
        </p>
      </div>
    </Section>
  );
}
