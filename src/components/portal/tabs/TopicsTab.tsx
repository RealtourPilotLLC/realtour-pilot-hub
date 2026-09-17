import type { PortalInterviewView, PortalTopicsData } from "@/lib/portal";
import { LoadFailed } from "@/components/portal/ui";
import { TopicBank } from "@/components/portal/TopicBank";
import { InterviewFlow } from "@/components/portal/InterviewFlow";

// VIDEO TOPICS — the bank (TopicBank) or, with ?iv=<id>, one topic's guided
// interview (InterviewFlow). Both are the client's own data only; the server
// components upstream proved ownership before anything reached this file.
export function TopicsTab({ topics, failed, interview, interviewFailed, href, canAct, readOnly, filter }: {
  topics: PortalTopicsData | null;
  failed: boolean;
  interview: PortalInterviewView | null;
  interviewFailed: boolean;
  href: (tab: string, extra?: string) => string;
  canAct: boolean;
  readOnly: boolean;
  filter: string | undefined;
}) {
  if (interviewFailed) return <div className="mt-6"><LoadFailed what="those questions" /></div>;
  if (interview) return <div className="mt-6"><InterviewFlow iv={interview} backHref={href("topics")} canAct={canAct && !readOnly} /></div>;
  if (failed) return <div className="mt-6"><LoadFailed what="your video topics" /></div>;
  if (!topics) return null;
  return (
    <div className="mt-6">
      <h1 className="text-xl font-semibold tracking-tight">Video Topics</h1>
      <p className="mt-0.5 mb-4 text-xs text-muted">Your bank of ideas, by pillar. Pick what we film next, answer a few questions per topic, and we script it.</p>
      <TopicBank groups={topics.groups} months={topics.months} archivedCount={topics.archivedCount} total={topics.total} strategyLabel={topics.strategyLabel} canAct={canAct} readOnly={readOnly} initialFilter={filter} tabHref={href("topics")} />
    </div>
  );
}
