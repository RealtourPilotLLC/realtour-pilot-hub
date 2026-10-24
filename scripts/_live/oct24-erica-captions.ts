export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 24 2026). Jordan: "run it on her video two most recent
// videos and see how the captions come out." Erica Walker's two most recently
// approved monthly videos get a Deepgram transcript (when they have none) and
// an Instagram caption, through the same function as Monthly Content's
// "Generate an Instagram caption" button (postingKit.generateCaptionForStaff),
// as Jordan. Dry run by default: names the two videos and what each has;
// --apply transcribes and drafts, then prints each caption.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const APPLY = process.argv.includes("--apply");
const ERICA = "cmt7h6b0300059kcj990r34x7";

let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };
  const videos = await prisma.contentVideo.findMany({ where: { enrollmentId: ERICA, status: { not: "ARCHIVED" } }, select: { id: true, title: true, finalSubmissionId: true, approvedSubmissionId: true, currentSubmissionId: true } });
  const withApproval: { id: string; title: string; subId: string; decidedAt: Date }[] = [];
  for (const v of videos) {
    const ids = [v.finalSubmissionId, v.approvedSubmissionId, v.currentSubmissionId].filter((x): x is string => !!x);
    const sub = ids.length ? await prisma.reviewSubmission.findFirst({ where: { id: { in: ids }, status: "APPROVED" }, orderBy: { round: "desc" }, select: { id: true, decidedAt: true } }) : null;
    if (sub?.decidedAt) withApproval.push({ id: v.id, title: v.title ?? "(untitled)", subId: sub.id, decidedAt: sub.decidedAt });
  }
  const two = withApproval.sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime()).slice(0, 2);
  const { transcriptForCut } = await import("../../src/lib/cutTranscripts");
  console.log(`=== ${APPLY ? "APPLY" : "DRY RUN"} === Erica's two most recently approved videos:`);
  for (const v of two) {
    const t = await transcriptForCut(v.subId).catch(() => null);
    const caps = await prisma.contentCaptionDraft.count({ where: { videoId: v.id, kind: "CAPTION", status: { not: "ARCHIVED" } } });
    console.log(`- ${v.title} · approved ${v.decidedAt.toISOString()} · transcript: ${t?.text ? "yes" : "none"} · captions: ${caps}`);
  }
  if (!APPLY) process.exit(0);
  const { generateCaptionForStaff } = await import("../../src/lib/postingKit");
  for (const v of two) {
    const r = await generateCaptionForStaff(v.id, { userId: owner.id, name: owner.name });
    console.log(`\n### ${v.title}\n${r.ok ? "ok" : "NOT DONE"}: ${r.message}`);
    const t = await transcriptForCut(v.subId).catch(() => null);
    console.log(`Transcript: ${t?.text ? `${t.text.split(/\s+/).length} words` : "none (drafted from the script)"}`);
    const cap = await prisma.contentCaptionDraft.findFirst({ where: { videoId: v.id, kind: "CAPTION" }, orderBy: { createdAt: "desc" }, select: { body: true, alternativesJson: true } });
    if (cap) {
      console.log(`--- caption ---\n${cap.body}\n---`);
      try { const a = JSON.parse(cap.alternativesJson ?? "{}"); if (a.sourceNote) console.log(`Source: ${a.sourceNote}`); if (a.fixes?.length) console.log(`Code fixes: ${a.fixes.join("; ")}`); if (a.gaps?.length) console.log(`To check: ${a.gaps.join(" ")}`); } catch { /* none */ }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
