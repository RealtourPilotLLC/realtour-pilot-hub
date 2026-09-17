"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { BrandWordmark } from "@/components/Brand";
import { ArrowRight, KeyRound, Loader2, LogOut, MailCheck } from "lucide-react";
import { requestPortalLoginLink, signOutPortal } from "@/app/portal/login/actions";

// The sign-in screen — also what an expired or rotated link lands on (HTTP
// 200, no data). Same rules as the rest of the portal: no hub links, no
// internal vocabulary, and no hint about WHICH account exists — the sentence
// after "send" is identical for a client, a stranger and a typo.
const REASONS: Record<string, string> = {
  expired: "That link has expired. Sign in with your email to continue.",
  rotated: "That link has been replaced with a newer one. Sign in with your email to continue.",
  invalid: "That sign-in link is no longer valid — they work once and expire after 15 minutes. Request a fresh one below.",
  signedout: "You're signed out.",
  noaccess: "This email doesn't have access to a program right now. Reply to any text or email from us and we'll sort it.",
  revoked: "This portal is no longer available. Reply to any text or email from us if that's unexpected.",
};

/** `signedIn`: the person the cookie names, when there is one. canEnter =
 *  they hold a live seat (offer the door); otherwise only Sign out — a
 *  revoked person must be able to clear the cookie from THIS page, because
 *  no other page will render for them. */
export function PortalSignIn({ reason, signedIn }: { reason?: string; signedIn?: { who: string; canEnter: boolean } | null }) {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const note = reason ? REASONS[reason] : null;

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
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted">Signed in as <span className="font-semibold text-foreground">{signedIn.who}</span></span>
              {signedIn.canEnter && (
                <Link href="/portal/me" className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 font-semibold text-white">
                  Open your portal <ArrowRight className="size-3.5" />
                </Link>
              )}
              <form action={signOutPortal}>
                <button type="submit" className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 font-semibold text-muted hover:text-foreground">
                  <LogOut className="size-3.5" /> Sign out
                </button>
              </form>
            </div>
          )}
          {done ? (
            <p className="mt-3 text-center text-sm text-muted">{done}</p>
          ) : (
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData();
                fd.set("email", email);
                start(async () => {
                  const r = await requestPortalLoginLink(fd).catch(() => ({ ok: true as const, message: "If that email has portal access, a sign-in link is on its way." }));
                  setDone(r.message);
                });
              }}
            >
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Your email</span>
                <input
                  type="email" required autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm outline-none focus:border-brand"
                />
              </label>
              <button type="submit" disabled={busy || !email.trim()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow hover:opacity-90 disabled:opacity-40">
                {busy && <Loader2 className="size-4 animate-spin" />} Email me a sign-in link
              </button>
              <p className="text-center text-[11px] text-muted-2">No password — we send a one-time link that works for 15 minutes.</p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
