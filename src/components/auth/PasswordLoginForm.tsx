"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { loginWithPassword } from "@/app/login/actions";

// Email + password sign-in, shown under the "Continue with Google" button.
// The password never touches our JS beyond this form field → the server action
// (which hashes/compares). On success the server has already set the session
// cookie; we just navigate.
export function PasswordLoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const fd = new FormData(e.currentTarget);
    fd.set("next", next);
    start(async () => {
      const r = await loginWithPassword(fd);
      if (r.ok) router.push(r.redirect);
      else setErr(r.message);
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2 text-left">
      <input
        type="email"
        name="email"
        required
        autoComplete="email"
        placeholder="you@email.com"
        className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <input
        type="password"
        name="password"
        required
        autoComplete="current-password"
        placeholder="Password"
        className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      {err && <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{err}</p>}
      <button
        type="submit"
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy && <Loader2 className="size-4 animate-spin" />} Sign in
      </button>
    </form>
  );
}
