import Link from "next/link";
import { redirect } from "next/navigation";
import { FileText, ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { etDateTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// Everything Ask the Hub has written down. The finance advisor could already
// save a formal statement; this is the general case — any answer worth keeping
// instead of letting it scroll out of a chat.

const KIND_LABEL: Record<string, string> = {
  report: "Report", sop: "SOP", brief: "Brief", plan: "Plan", summary: "Summary", doc: "Document",
};

export default async function HubDocsPage() {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/assistant/docs");
  if (me && !canAccess(me, "assistant")) redirect("/");

  const docs = await prisma.hubDocument.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, kind: true, createdBy: true, createdAt: true, markdown: true },
    take: 200,
  });

  return (
    <div>
      <PageHeader title="Documents" subtitle="Reports, SOPs and briefs Ask the Hub has written and saved" />
      <div className="mx-auto max-w-3xl space-y-3 p-4 pb-16 sm:p-6">
        <Link href="/assistant" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
          <ArrowLeft className="size-4" /> Back to Ask the Hub
        </Link>

        {docs.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center">
            <FileText className="mx-auto mb-3 size-8 text-muted-2" />
            <p className="text-base text-muted">
              Nothing saved yet. Ask the Hub for a report, an SOP or a summary and tell it to save it —
              it&rsquo;ll show up here.
            </p>
          </div>
        ) : (
          docs.map((d) => (
            <Link
              key={d.id}
              href={`/assistant/docs/${d.id}`}
              className="block rounded-xl border border-border bg-surface p-4 transition hover:border-brand"
            >
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 size-5 shrink-0 text-brand" />
                <div className="min-w-0 flex-1">
                  <div className="text-base font-semibold leading-snug">{d.title}</div>
                  <div className="mt-0.5 text-sm text-muted">
                    {KIND_LABEL[d.kind] ?? "Document"} · {etDateTime(d.createdAt)}
                    {d.createdBy ? ` · ${d.createdBy}` : ""}
                  </div>
                  {/* First real line, so the list is scannable without opening. */}
                  <p className="mt-1 line-clamp-2 text-sm text-muted-2">
                    {d.markdown.replace(/^#+\s.*$/gm, "").replace(/[*_`|>-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180)}
                  </p>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
