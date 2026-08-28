import { PasswordLoginForm } from "@/components/auth/PasswordLoginForm";
import { BrandWordmark } from "@/components/Brand";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  config: "Login isn't configured yet. Add the Google credentials and try again.",
  state: "Your session expired before sign-in finished. Please try again.",
  google: "We couldn't verify your Google account. Please try again.",
  denied: "That Google account doesn't have access. Ask the owner to invite you.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] ?? "Couldn't sign you in. Please try again." : null;
  const next = sp.next && sp.next.startsWith("/") ? sp.next : "/";
  const loginHref = `/api/auth/login?next=${encodeURIComponent(next)}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand/[0.08] via-surface to-surface p-6">
      <div className="panel-shadow w-full max-w-sm rounded-2xl border border-border bg-surface p-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
<img src="/brand/mark.svg" alt="RealTour Pilot" className="flex size-12 rounded-xl bg-white p-1" />
        <h1 className="text-lg font-semibold tracking-tight">
          <BrandWordmark className="text-[15px]" />
        </h1>
        <p className="mt-1 text-sm text-muted">Operations Hub — sign in to continue</p>

        {error && (
          <p className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        )}

        <a
          href={loginHref}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-white px-4 py-2.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
        >
          <svg className="size-4" viewBox="0 0 48 48" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.4 0 10.3-2.1 14-5.4l-6.5-5.3C29.5 34.9 26.9 36 24 36c-5.2 0-9.6-3.3-11.2-7.9l-6.6 5.1C9.6 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.4l6.5 5.3C40.9 36.5 44 30.8 44 24c0-1.3-.1-2.3-.4-3.5z" />
          </svg>
          Continue with Google
        </a>

        {/* Email + password — for team members on personal emails that a
            Workspace-"Internal" Google app rejects. Owners/admins can use
            either; a set-password link makes the account. */}
        <div className="my-5 flex items-center gap-3 text-[11px] text-muted-2">
          <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
        </div>
        <PasswordLoginForm next={next} />

        <p className="mt-4 text-[11px] text-muted-2">Access is invite-only.</p>
      </div>
    </div>
  );
}
