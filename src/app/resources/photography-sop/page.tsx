import { Camera } from "lucide-react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requirePageAccess } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { Markdown } from "@/components/ui/Markdown";

export const dynamic = "force-dynamic";

// The master Photography SOP as its own full page (Jordan, Sep 1 2026) — the
// upload portal and the welcome agreement deep-link here. Content lives in the
// Sop table (single source: also appears in the SOP Center and the Hub's KB).
export default async function PhotographySopPage() {
  await requirePageAccess("resources");
  const sop = await prisma.sop.findFirst({
    where: { title: { startsWith: "Photography SOP" } },
    select: { title: true, content: true, updatedAt: true },
  });
  if (!sop) notFound();

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/resources" label="Resources & SOPs" />
      </div>
      <PageHeader
        eyebrow="The RealTour Pilot standard"
        title="Photography SOP"
        subtitle={`Shooting, on-site preparation, culling & upload standards · updated ${sop.updatedAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" })}`}
        actions={
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand/15 text-brand">
            <Camera className="size-5" />
          </span>
        }
      />
      <div className="mx-auto max-w-3xl p-4 pb-16 sm:p-6">
        <Markdown content={sop.content} />
      </div>
    </div>
  );
}
