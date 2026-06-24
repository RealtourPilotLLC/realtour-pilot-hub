import { notFound } from "next/navigation";
import Link from "next/link";
import { PieChart, MessagesSquare, ShieldCheck, ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { HubPie } from "@/components/assistant/HubPie";
import { ChatHistoryList, type ChatListItem } from "@/components/assistant/ChatHistoryList";
import { isOwnerView } from "@/lib/access";
import { listHubChats, hubQuestionStats, summarizeHubChat, CATEGORY_META } from "@/lib/hubChats";
import { etDateTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function HubHistoryPage() {
  // Owner-only surface (chat history can hold owner-tier knowledge + private DMs).
  if (!(await isOwnerView())) notFound();

  // Pre-build summaries for the most recent stale chats so the page reads well on
  // open; older ones get an on-demand "Generate summary" button. Bounded for cost.
  const recent = await listHubChats(100);
  const toFill = recent.filter((c) => c.messageCount >= 2 && !c.fresh).slice(0, 12);
  await Promise.all(toFill.map((c) => summarizeHubChat(c.id).catch(() => null)));

  const [stats, chats] = await Promise.all([hubQuestionStats(), listHubChats(100)]);

  const items: ChatListItem[] = chats.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    categoryLabel: CATEGORY_META[c.category].label,
    categoryColor: CATEGORY_META[c.category].color,
    role: c.role,
    questions: Math.max(1, Math.round(c.messageCount / 2)),
    when: etDateTime(c.lastMessageAt),
  }));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Owner only"
        title="Hub History & Insights"
        subtitle="Every Ask the Hub conversation, with summaries and what the team asks most"
        actions={
          <Link
            href="/assistant"
            className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
          >
            <ArrowLeft className="size-3.5" /> Back to Ask the Hub
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
        <div className="flex items-center gap-2 rounded-xl border border-brand/20 bg-brand-soft/30 px-3.5 py-2.5 text-xs text-muted">
          <ShieldCheck className="size-4 shrink-0 text-brand" />
          Visible to you (the owner) only. Conversations are stored so the brain can be reviewed and improved. Each chat was already filtered to what its viewer was allowed to see.
        </div>

        <Section icon={PieChart} title="What the team asks" count={stats.total ? `${stats.total} questions` : null} flush>
          <div className="p-5">
            <HubPie total={stats.total} slices={stats.slices} />
          </div>
          {stats.slices.length > 0 && (
            <div className="grid gap-3 border-t p-5 sm:grid-cols-2">
              {stats.slices.map((s) => (
                <div key={s.key} className="rounded-xl border bg-background/40 p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                    <span className="text-sm font-medium text-foreground">{s.label}</span>
                    <span className="ml-auto text-xs text-muted">{s.count} · {s.pct}%</span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted">{s.description}</p>
                  {s.examples.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {s.examples.map((ex, i) => (
                        <li key={i} className="truncate text-xs italic text-muted-2">&ldquo;{ex}&rdquo;</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section icon={MessagesSquare} title="Conversations" count={chats.length || null}>
          <ChatHistoryList chats={items} />
        </Section>
      </div>
    </div>
  );
}
