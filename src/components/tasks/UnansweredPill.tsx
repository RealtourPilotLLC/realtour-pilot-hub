import Link from "next/link";
import { Reply } from "lucide-react";

// "3 unanswered · 2 days" sitting next to the Tasks tabs.
//
// Kyle's day starts on /tasks, and the reply queue is the one pile that lives
// somewhere else. Without this he has to remember to go looking for it, and the
// 30-day comms review is very clear about what happens to messages nobody is
// reminded about.
//
// It shows the OLDEST wait, not just the count, because that's the number that
// actually makes someone act: three unanswered is a queue, one of them sitting
// two days is a client deciding we don't care. Turns red at a day.
export function UnansweredPill({ count, oldestHours }: { count: number; oldestHours: number }) {
  const stale = oldestHours >= 24;
  const age = stale
    ? `${Math.round(oldestHours / 24)}d`
    : oldestHours >= 1
      ? `${oldestHours}h`
      : null;

  return (
    <Link
      href="/communications?tab=replies"
      title="Inbound texts still waiting on an answer — each one comes with a draft"
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
        stale ? "bg-danger-soft text-danger hover:opacity-80" : "bg-brand/10 text-brand hover:bg-brand/20"
      }`}
    >
      <Reply className="size-3.5" />
      {count} unanswered
      {age && <span className="font-normal opacity-80">· oldest {age}</span>}
    </Link>
  );
}
