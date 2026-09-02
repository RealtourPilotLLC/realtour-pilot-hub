import { notFound } from "next/navigation";
import { BrandWordmark } from "@/components/Brand";
import { prisma } from "@/lib/prisma";
import { FeedbackForm } from "./FeedbackForm";

export const dynamic = "force-dynamic";

// The root layout titles every page "RealTour Pilot — Operations Hub" — not
// what an agent should read in the tab of a form we texted them. Own it here,
// and keep the form out of search results: it names a real client's address.
export const metadata = {
  title: "How did we do? — RealTour Pilot",
  robots: { index: false, follow: false },
};

// Public, client-facing feedback form (linked from the post-delivery text —
// see feedbackUrl() in src/lib/delivery.ts). The Shell renders this route bare
// (isBare in src/components/Shell.tsx) — no sidebar, no staff feedback widget,
// no links into the hub. It used to rely on the full-screen layer below to
// COVER the chrome, which the z-1400 staff widget sat on top of and which did
// nothing for view-source (audit, Sep 2).
//
// This page is the SOURCE OF TRUTH for what the submit is about: middleware
// treats /feedback/<one-segment> as public, and the server action reads the job
// id back off this route rather than off a form field (a "use server" action
// can be POSTed from any public path with a forged body). Everything below is
// display; nothing here is trusted on the way back in.
export default async function FeedbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      client: { select: { name: true } },
      // Who actually shot it. The first question names this person, and the
      // answer is stamped onto them for their KPI. 1,470 of 1,542 jobs carry
      // one; the 72 that don't still get the question, just without a name.
      photographer: { select: { name: true } },
    },
  });
  if (!project) notFound();

  const first = (n: string | null | undefined) => (n || "").trim().split(/\s+/)[0] || "";
  const street = (project.title || "your shoot").split(",")[0].trim() || "your shoot";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background p-6">
      <div className="w-full max-w-md py-2">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/mark.svg" alt="RealTour Pilot" className="flex size-9 rounded-xl bg-white p-1" />
          <div className="text-sm font-semibold tracking-tight">
            <BrandWordmark className="h-4" />
          </div>
        </div>
        <div className="rounded-2xl border bg-surface p-6 shadow-xl">
          <FeedbackForm
            projectId={project.id}
            street={street}
            clientFirstName={first(project.client.name)}
            photographerFirstName={first(project.photographer?.name) || null}
          />
        </div>
        <p className="mt-4 text-center text-xs text-muted-2">Your feedback goes straight to our team.</p>
      </div>
    </div>
  );
}
