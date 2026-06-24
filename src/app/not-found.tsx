import Link from "next/link";
import { SearchX } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-muted-2">
        <SearchX className="size-7" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="max-w-sm text-sm text-muted">
        That project, client, or page doesn’t exist — it may have been removed or the link is out of date.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:opacity-90"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
