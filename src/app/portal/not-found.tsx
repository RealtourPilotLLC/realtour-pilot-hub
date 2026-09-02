import { BrandWordmark } from "@/components/Brand";
import { Link2Off } from "lucide-react";

// A dead portal link is a CLIENT-FACING screen: the page calls notFound() for a
// malformed token, a token that no longer matches an enrollment, and — the
// common one — an enrollment that has been paused or cancelled. Without this
// file those all fell through to the app-wide src/app/not-found.tsx, which
// says "That project, client, or page doesn't exist" and offers a "Back to
// dashboard" button straight into the hub. An agent whose program ended would
// have landed on our internal software (audit, Sep 2).
//
// Same rule as the portal itself: no hub links, no internal vocabulary, no
// money, and no hint about WHY the link is dead — a paused account is not
// something to announce on a page anyone with the URL can open.
export default function PortalNotFound() {
  return (
    <div className="portal-light fixed inset-0 flex items-center justify-center overflow-y-auto bg-background p-6 text-foreground">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8 flex justify-center">
          <BrandWordmark variant="onLight" className="h-5" />
        </div>
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-muted-2">
          <Link2Off className="size-7" />
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">This link isn&rsquo;t active</h1>
        <p className="mt-2 text-sm text-muted">
          Your portal link may have been replaced with a newer one. Reply to any text or email
          from us and we&rsquo;ll send you a fresh link right away.
        </p>
      </div>
    </div>
  );
}
