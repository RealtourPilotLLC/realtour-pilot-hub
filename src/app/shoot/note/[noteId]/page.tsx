import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { photographerMemberId } from "@/lib/shoot";
import { isMentionedIn } from "@/lib/mentions";
import { stripMoneySentences } from "@/lib/text";
import { toReviewNote } from "@/lib/review";
import { etDateTime } from "@/lib/datetime";
import { BackLink } from "@/components/ui/BackLink";
import { ShootFeedback } from "@/components/shoot/ShootFeedback";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// One feedback-note thread, standalone — the landing page for mention pings and
// thread-reply texts. A tagged photographer may not OWN the shoot the note sits
// on (/shoot/<id> bounces non-owners and the mention evaporates), so this page
// admits the note's ADDRESSEE and anyone @-tagged on the thread, and shows the
// note alone: street + the thread, NO client name/phone, NO order details, NO
// pay. The route lives under /shoot/, so the middleware's prefix match gates it
// with the "shoot" page key (photographer/admin/owner roles pass).
// ---------------------------------------------------------------------------

export default async function ShootNotePage({ params }: { params: Promise<{ noteId: string }> }) {
  const { noteId } = await params;

  // A reply link re-roots to its thread's root note (same pattern the
  // replyMediaNote action uses) — the page always shows the whole thread.
  const hit = await prisma.mediaNote.findUnique({ where: { id: noteId }, select: { id: true, parentId: true } });
  if (!hit) notFound();
  const root = await prisma.mediaNote.findUnique({
    where: { id: hit.parentId ?? hit.id },
    include: {
      replies: { orderBy: { createdAt: "asc" } },
      // Title only — the header shows the street; nothing else about the order
      // belongs on a page a non-owning photographer can open.
      project: { select: { title: true } },
    },
  });
  if (!root) notFound();

  // Guard, fail closed (same shape as /shoot/[id]): a disabled account's stale
  // JWT passes the middleware, and a null user must never read as "owner-ish".
  const user = await getCurrentUser();
  if (!user && authEnforced()) redirect("/login");
  // Editors get /edit hrefs from the mention router — this page isn't for them.
  if (user?.role === "EDITOR") redirect("/edit");
  let viewerMemberId: string | null = null;
  if (user?.role === "PHOTOGRAPHER") {
    viewerMemberId = await photographerMemberId(user);
    // Admitted: the photographer the note is addressed to, or anyone @-tagged
    // on the thread — isMentionedIn runs the EXACT matcher that minted the
    // ping, so the page always opens for whoever the bell/SMS pointed here.
    const admitted =
      viewerMemberId != null &&
      (viewerMemberId === root.photographerId ||
        (await isMentionedIn([root.body, ...root.replies.map((r) => r.body)], viewerMemberId)));
    if (!admitted) redirect("/shoot");
  } else if (user && user.role !== "OWNER" && user.role !== "ADMIN") {
    redirect("/shoot");
  }

  // Read receipt: ONLY the note's own photographer opening it themselves —
  // a merely-mentioned viewer (or an owner preview) must never stamp the
  // addressee's receipt. Stamp THIS thread's root only: the page shows one
  // note, so the project-wide helper would claim they read feedback they
  // never loaded.
  const isAddressee =
    user?.role === "PHOTOGRAPHER" && !user.impersonating &&
    viewerMemberId != null && viewerMemberId === root.photographerId;
  if (isAddressee && !root.seenAt) {
    await prisma.mediaNote.update({ where: { id: root.id }, data: { seenAt: new Date() } }).catch(() => {});
  }

  // Money scrub, defense-in-depth: pricing never crosses to a creative surface,
  // even inside a reviewer's own words on the thread.
  let note = toReviewNote(root);
  if (!(user?.role === "OWNER" || user?.role === "ADMIN")) {
    note = {
      ...note,
      body: stripMoneySentences(note.body),
      replies: note.replies.map((r) => ({ ...r, body: stripMoneySentences(r.body) })),
    };
  }

  // Reply / mark-fixed stay live only for the real photographer themselves
  // (owner/admin + "view as" are read-only on field surfaces, matching
  // /shoot/[id]); the server actions enforce the same rule regardless.
  const readOnly = !(user?.role === "PHOTOGRAPHER" && !user.impersonating);
  const street = (root.project?.title ?? "").split(",")[0].trim() || "Shoot";

  return (
    <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
      <BackLink href="/shoot" label="My Shoots" className="mb-3" />
      <div className="mb-4">
        <div className="eyebrow mb-1">Feedback note</div>
        <h1 className="text-xl font-semibold tracking-tight">{street}</h1>
        <p className="mt-0.5 text-sm text-muted">
          {note.authorName ?? "RealTour"} · {etDateTime(note.createdAt)}
        </p>
      </div>
      {/* The exact card family the shoot page renders — badges, the pinned
          media preview (pin at x/y, video parked at the noted moment), the
          thread, and the reply box wired to replyMediaNote. A merely-mentioned
          photographer is reply-only: Mark-fixed / Got-it belong to the
          addressee (the server rejects anyone else — don't offer the button). */}
      <ShootFeedback notes={[note]} readOnly={readOnly} replyOnly={!readOnly && !isAddressee} photographerName={null} />
    </div>
  );
}
