import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { DocActions } from "@/components/assistant/DocActions";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { etDateTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function HubDocPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/assistant/docs");
  if (me && !canAccess(me, "assistant")) redirect("/");

  const { id } = await params;
  const doc = await prisma.hubDocument.findUnique({ where: { id } });
  if (!doc) notFound();

  return (
    <div className="mx-auto max-w-3xl p-4 pb-16 sm:p-6">
      {/* print:hidden throughout — printing this should produce the document,
          not the document plus the app's furniture. */}
      <div className="print:hidden">
        <Link href="/assistant/docs" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
          <ArrowLeft className="size-4" /> All documents
        </Link>
      </div>

      <header className="mt-3 border-b border-border pb-4">
        <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{doc.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {etDateTime(doc.createdAt)}
          {doc.createdBy ? ` · ${doc.createdBy}` : ""}
        </p>
      </header>

      <div className="my-4 print:hidden">
        <DocActions id={doc.id} title={doc.title} markdown={doc.markdown} />
      </div>

      <article className="text-[15px] leading-relaxed">
        <Markdown content={doc.markdown} />
      </article>
    </div>
  );
}
