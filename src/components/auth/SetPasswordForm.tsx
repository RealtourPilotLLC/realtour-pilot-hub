"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { setPasswordFromToken } from "@/app/login/actions";

// "Choose a password" form on the invite / reset link. On success the server
// action has hashed the password, consumed the token, and set the session
// cookie — so we just navigate into the app.
export function SetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, start] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (pw !== pw2) { setErr("The two passwords don't match."); return; }
    const fd = new FormData();
    fd.set("token", token);
    fd.set("password", pw);
    start(async () => {
      const r = await setPasswordFromToken(fd);
      if (r.ok) router.push(r.redirect);
      else setErr(r.message);
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-2 text-left">
      <input
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="Choose a password (8+ characters)"
        className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <input
        type="password"
        value={pw2}
        onChange={(e) => setPw2(e.target.value)}
        required
        minLength={8}
        autoComplete="new-password"
        placeholder="Confirm password"
        className="w-full rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      {err && <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{err}</p>}
      <button
        type="submit"
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy && <Loader2 className="size-4 animate-spin" />} Set password &amp; sign in
      </button>
    </form>
  );
}
