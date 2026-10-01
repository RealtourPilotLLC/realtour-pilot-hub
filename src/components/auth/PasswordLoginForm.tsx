"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ActionLink } from "@/components/ui/Action";
import { TextField } from "@/components/ui/FormField";
import { loginWithPassword } from "@/app/login/actions";

// Email + password sign-in, shown under the "Continue with Google" button.
// The password never touches our JS beyond this form field → the server action
// (which hashes/compares). On success the server has already set the session
// cookie; we just navigate.
export function PasswordLoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const busyRef = useRef(false);
  const [unconfirmed, setUnconfirmed] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busyRef.current) return;
    let fd: FormData;
    try { fd = new FormData(e.currentTarget); fd.set("next", next); }
    catch { setErr("Sign-in could not be prepared. No request was started. Keep your input and try again."); return; }
    busyRef.current = true;
    setErr(null); setUnconfirmed(false);
    start(async () => {
      try {
        const r = await loginWithPassword(fd);
        if (r.ok) router.push(r.redirect);
        else setErr(r.message);
      } catch {
        setUnconfirmed(true);
        setErr("We couldn’t confirm sign-in. Your session may already be active. Open the dashboard to check. Your input has been kept in this form.");
      } finally { busyRef.current = false; }
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2 text-left">
      <TextField id="password-login-email" label="Email" type="email" name="email" required autoComplete="email" placeholder="you@email.com" />
      <TextField id="password-login-password" label="Password" type="password" name="password" required autoComplete="current-password" />
      {err && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm leading-relaxed text-danger">{err}</p>}
      {unconfirmed && <ActionLink href="/">Open the dashboard</ActionLink>}
      <Button type="submit" busy={busy} className="w-full">Sign in</Button>
    </form>
  );
}
