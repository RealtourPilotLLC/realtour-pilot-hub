"use client";

import { useEffect, useRef, useTransition } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { ActionLink, Button } from "@/components/ui/Action";

// Something broke on a page. Before this existed, a failure showed the browser's
// own blank error screen: the person had nothing to read, nothing to press and
// nothing to report, so a bug looked like a dead internet connection (Sep 2
// readiness audit). Every failure should be reportable by the person who hit it.
export default function ErrorScreen({ error, unstable_retry }: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const retrying = useRef(false);
  useEffect(() => {
    // The digest is what ties this to the server log — always print it.
    console.error("Page error", error.digest ?? "", error);
  }, [error]);
  useEffect(() => {
    // The framework retry returns void. Release only after a committed render
    // says its transition has settled, including a render of another failure.
    if (!pending) retrying.current = false;
  });

  function retry() {
    if (retrying.current || pending) return;
    retrying.current = true;
    // Next 16's reset only rerenders. Retry also refreshes the current route's
    // server data; it does not repeat an interrupted save or send.
    startTransition(unstable_retry);
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="panel-shadow w-full max-w-md rounded-2xl border border-border bg-surface p-6">
        <span className="flex size-10 items-center justify-center rounded-xl bg-warning/15 text-warning">
          <AlertTriangle aria-hidden className="size-5" />
        </span>
        <h1 className="mt-3 text-lg font-semibold tracking-tight">This page hit a problem</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          We couldn’t load this page. Try again to load its current saved information.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          If this interrupted a save or send, check its recorded status before trying that action again.
          Unsaved text may need to be entered again.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          If the page still won’t load, report it to Jordan with the reference below, if shown.
        </p>
        {error.digest && (
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-muted">
            Reference: {error.digest}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={retry} busy={pending} busyLabel="Loading current information…">
            <RefreshCw aria-hidden className="size-4" /> Try again
          </Button>
          <ActionLink href="/" prefetch={false}>
            Back to home
          </ActionLink>
          <ActionLink href="/feedback" prefetch={false}>
            Report it
          </ActionLink>
        </div>
      </div>
    </div>
  );
}
