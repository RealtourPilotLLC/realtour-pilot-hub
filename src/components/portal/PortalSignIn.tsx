"use client";

import { useRef, useState } from "react";
import { BrandWordmark } from "@/components/Brand";
import { ArrowRight, KeyRound, LogOut, MailCheck } from "lucide-react";
import { Button, ActionLink } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { useAccessAttempt } from "./useAccessAttempt";
import { requestPortalLoginLink, signOutPortal } from "@/app/portal/login/actions";

// The sign-in screen — also what an expired or rotated link lands on (HTTP
// 200, no data). Same rules as the rest of the portal: no hub links, no
// internal vocabulary, and no hint about WHICH account exists — the sentence
// after "send" is identical for a client, a stranger and a typo.
const REASONS: Record<string, string> = {
  expired: "That link has expired. Sign in with your email to continue.",
  rotated: "That link has been replaced with a newer one. Sign in with your email to continue.",
  // A token no enrollment carries: it may have been replaced, or it may never
  // have existed. We cannot tell, so we claim neither.
  unknown: "That link isn't working any more. Sign in with your email to continue.",
  invalid: "That sign-in link is no longer valid — each link works once, for a limited time. Request a fresh one below.",
  signedout: "You're signed out.",
  noaccess: "This email doesn't have access to a program right now. Reply to any text or email from us and we'll sort it.",
  revoked: "This portal is no longer available. Reply to any text or email from us if that's unexpected.",
};

/** `signedIn`: the person the cookie names, when there is one. canEnter =
 *  they hold a live seat (offer the door); otherwise only Sign out — a
 *  revoked person must be able to clear the cookie from THIS page, because
 *  no other page will render for them. */
export function PortalSignIn({ reason, signedIn, emailSignIn = true }: { reason?: string; signedIn?: { who: string; canEnter: boolean } | null;
  /** False while `portal_login_email` is off: the form would take an address and send nothing. */
  emailSignIn?: boolean }) {
  const [email, setEmail] = useState("");
  const emailRef = useRef("");
  const [receipt, setReceipt] = useState<{ email: string; message: string } | null>(null);
  const attempt = useAccessAttempt("portal-login-unconfirmed");
  const done = !attempt.held && receipt?.email === email ? receipt.message : null;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!emailSignIn || !emailRef.current.trim()) return;
    const id = attempt.begin("login");
    if (!id) return;
    const requestedEmail = emailRef.current;
    const fd = new FormData(); fd.set("email", requestedEmail);
    try {
      const r = await requestPortalLoginLink(fd);
      setReceipt({ email: requestedEmail, message: r.message });
      attempt.finish(id, true);
    } catch {
      attempt.finish(id, false);
    }
  }
  // With the email form off, every "Sign in with your email to continue" is an
  // instruction the page cannot honour — drop the clause, keep the news.
  const raw = reason ? REASONS[reason] : null;
  const note = raw && !emailSignIn ? raw.replace(" Sign in with your email to continue.", "").replace(" Request a fresh one below.", "") : raw;

  return (
    <div className="portal-light fixed inset-0 flex items-center justify-center overflow-y-auto bg-background p-6 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandWordmark variant="onLight" className="h-5" />
        </div>
        <div className="panel-shadow rounded-2xl border border-border bg-surface/80 p-5 backdrop-blur">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            {done ? <MailCheck className="size-6" /> : <KeyRound className="size-6" />}
          </span>
          <h1 className="mt-4 text-center text-xl font-semibold tracking-tight">Sign in to your portal</h1>
          {note && !done && <p className="mt-2 text-center text-sm text-muted">{note}</p>}
          {signedIn && !done && (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1 break-words text-muted">Signed in as <span className="font-semibold text-foreground">{signedIn.who}</span></span>
              {signedIn.canEnter && (
                <ActionLink href="/portal/me" variant="primary">
                  Open your portal <ArrowRight className="size-3.5" />
                </ActionLink>
              )}
              <form action={signOutPortal}>
                <Button type="submit" variant="secondary">
                  <LogOut className="size-3.5" /> Sign out
                </Button>
              </form>
            </div>
          )}
          {!emailSignIn && !done && (
            <p className="mt-4 rounded-xl border border-border bg-surface px-3 py-2.5 text-center text-sm text-muted">
              Email sign-in isn&rsquo;t switched on yet. Reply to any text or email from us and we&rsquo;ll get you in.
            </p>
          )}
          {attempt.held && (
            <div role="alert" className="mt-4 space-y-3 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm leading-relaxed">
              <p>We couldn’t confirm your sign-in request. It may already have been processed. Check your inbox or open your portal if you already signed in. Reply to any text or email from us and ask our team to check before requesting another link.</p>
              <p>This tab holds repeat requests. Reloading does not confirm what happened; unsaved email input is kept only while this form stays open.</p>
              <ActionLink href="/portal/me">Open your portal</ActionLink>
            </div>
          )}
          {done ? (
            <p role="status" className="mt-3 text-center text-sm leading-relaxed text-muted">{done}</p>
          ) : !emailSignIn ? null : (
            <form className="mt-4 space-y-3" onSubmit={submit}>
              <TextField id="portal-login-email" name="email" label="Your email" type="email" required autoComplete="email" inputMode="email"
                value={email} onChange={(e) => { emailRef.current = e.target.value; setEmail(e.target.value); }} placeholder="you@example.com" />
              <Button type="submit" busy={attempt.pending} disabled={attempt.blocked || !email.trim()} className="w-full">Email me a sign-in link</Button>
              {receipt && <p role="status" className="text-sm leading-relaxed text-muted">{receipt.message} This response is for your earlier request; your newer email has been kept.</p>}
              <p className="text-center text-sm text-muted">No password — available sign-in links work once and expire in 15 minutes.</p>
            </form>
          )}
          {attempt.localError && <p role="alert" className="mt-3 text-sm text-danger">{attempt.localError}</p>}
        </div>
      </div>
    </div>
  );
}
