import { BrandWordmark } from "@/components/Brand";
import { MessageSquareOff } from "lucide-react";

// The delivery text sends agents to /feedback/<projectId>; the page calls
// notFound() when that job no longer exists (merged client, retired project,
// mistyped link). Without this file the app-wide src/app/not-found.tsx answered
// — "That project, client, or page doesn't exist" plus a "Back to dashboard"
// button into the hub. Feedback links went out to real agents this week, so
// that 404 is a client-facing screen and gets client-facing words: no internal
// vocabulary, no hub link, and a way to still be heard.
export default function FeedbackNotFound() {
  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8 flex justify-center">
          <BrandWordmark className="h-5" />
        </div>
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-muted-2">
          <MessageSquareOff className="size-7" />
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">This form has closed</h1>
        <p className="mt-2 text-sm text-muted">
          We couldn&rsquo;t find the shoot this link belongs to. Just reply to our text with your
          thoughts instead — it reaches the same people.
        </p>
      </div>
    </div>
  );
}
