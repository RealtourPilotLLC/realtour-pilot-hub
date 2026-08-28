import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { FeedbackForm } from "@/components/feedback/FeedbackForm";

export const dynamic = "force-dynamic";

// Public, client-facing feedback form (linked from the post-delivery text).
// Renders full-screen over the app shell so clients see a clean page.
export default async function FeedbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, title: true, client: { select: { name: true } } },
  });
  if (!project) notFound();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
<img src="/brand/mark.svg" alt="RealTour Pilot" className="flex size-9 rounded-xl bg-white p-1" />
          <div className="text-sm font-semibold tracking-tight">
            Real<span className="text-brand">Tour</span> Pilot
          </div>
        </div>
        <div className="rounded-2xl border bg-surface p-6 shadow-xl">
          <FeedbackForm projectId={project.id} title={project.title} clientName={project.client.name} />
        </div>
        <p className="mt-4 text-center text-xs text-muted-2">Your feedback goes straight to our team.</p>
      </div>
    </div>
  );
}
