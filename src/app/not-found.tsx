import Link from "next/link";
import { SearchX } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/user";

export default async function NotFound() {
  const signedIn = !!(await getCurrentUser().catch(() => null));
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-muted-2">
        <SearchX className="size-7" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="max-w-sm text-sm text-muted">
        That project, client, or page doesn’t exist — it may have been removed or the link is out of date.
      </p>
      {/* Only offer the hub to someone who has one. This boundary is serialized
          into every route's payload, so a signed-out client following a stale
          portal link should never be invited into internal software. */}
      {signedIn && (
        <Link
          href="/"
          className="mt-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:opacity-90"
        >
          Back to dashboard
        </Link>
      )}
    </div>
  );
}
