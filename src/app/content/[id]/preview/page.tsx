import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { BackLink } from "@/components/ui/BackLink";
import { PageHeader } from "@/components/PageHeader";
import { PortalLinkButton } from "@/components/content/PortalLinkButton";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { canPreviewPortal, contentHref } from "@/lib/contentNav";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// PREVIEW THEIR PORTAL (UI-02) — was the "Their portal" tab. The embedded
// portal is signed in AS STAFF acting on the client's behalf, so it stays the
// owner's window (canPreviewPortal: the effective role must be OWNER), and the
// on-behalf warning moved with it word for word. Anyone else who reaches this
// URL is sent back to the client file's Overview.
// ---------------------------------------------------------------------------
export default async function PortalPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/content");
  if (me && !canAccess(me, "content")) redirect("/");
  const { id } = await params;
  // Outside any try — redirect() works by throwing.
  if (!canPreviewPortal(me, authEnforced())) redirect(contentHref(id));

  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id }, select: { clientId: true, portalToken: true } });
  if (!enrollment) notFound();
  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });
  if (!client) notFound();

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href={contentHref(id)} label={client.name} />
      </div>
      <PageHeader eyebrow="Preview" title={`${client.name}'s portal`} subtitle="Exactly what they see — videos and profile included." actions={<PortalLinkButton enrollmentId={id} />} />
      <div className="mx-auto max-w-5xl space-y-3 p-4 pb-16 sm:p-6">
        {enrollment.portalToken ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 flex-1 basis-72 text-sm text-muted">
                This is {client.name.split(" ")[0]}&rsquo;s live portal.{" "}
                <span className="text-warning">Careful: anything you submit in here (a revision request, a comment, a profile change) is recorded as you, on their behalf — it is stamped with your staff account and labelled &ldquo;{me?.name ?? "Jordan Spackman"} (on behalf of {client.name})&rdquo;.</span>
              </p>
              <a
                href={`/portal/${enrollment.portalToken}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
              >
                <ExternalLink className="size-3.5" /> Open in a new tab
              </a>
            </div>
            <iframe
              src={`/portal/${enrollment.portalToken}`}
              title={`${client.name}'s client portal`}
              className="h-[78vh] w-full rounded-2xl border border-border bg-white"
            />
          </>
        ) : (
          <p className="rounded-2xl border border-border bg-surface px-5 py-4 text-sm text-muted">
            No portal link exists for this client yet — click <span className="font-medium text-foreground">Client portal link</span> up top to create it, then come back.
            {" "}Seats and visits are on the client&rsquo;s <Link href={contentHref(id, { tab: "settings" })} className="font-medium text-brand hover:underline">Settings</Link> tab.
          </p>
        )}
      </div>
    </div>
  );
}
