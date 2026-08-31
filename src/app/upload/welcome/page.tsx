import { CheckCircle2, FolderOpen, Scissors, Route, Eraser, Clapperboard, Upload } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AgreeButton } from "@/components/upload/AgreeButton";

export const dynamic = "force-dynamic";

// One-time onboarding for the new upload process (Jordan, Sep 1 2026). The
// 7 PM shoot text links here on first visit; after "I agree" the photographer
// lands on /upload and never sees this page again unless they come back.
export default function UploadWelcomePage() {
  return (
    <div className="mx-auto max-w-2xl p-4 pb-16 sm:p-6">
      <p className="text-xs font-bold uppercase tracking-widest text-brand">New for every shoot</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">The new upload process</h1>

      <p className="mt-4 text-[15px] leading-relaxed text-foreground/85">
        Starting now, every shoot finishes on its <strong>upload page</strong>. Your files still go straight to
        Dropbox like always — the page is where you and the office get aligned: what was shot, what needs editing
        attention, and your word that the gallery meets the standard. <strong>The job isn&rsquo;t done until the
        page is completed</strong> — same day as the shoot.
      </p>

      <div className="mt-5 rounded-2xl border border-brand/25 bg-brand/[0.05] p-4">
        <p className="text-sm leading-relaxed text-foreground/85">
          <strong>Why we&rsquo;re doing this:</strong> it&rsquo;s not to make your job harder. It&rsquo;s so we
          deliver the best possible experience to every client — that&rsquo;s how we keep growing, land more
          business, keep you busy, and stay aligned as a team. Presentation is everything.
        </p>
      </div>

      <h2 className="mt-7 text-lg font-semibold">How it works</h2>
      <div className="mt-3 space-y-2.5">
        <Row icon={FolderOpen} title="Upload to Dropbox" text="Raw files in the Raw folders. Culled extras in the new Backup Photos folder — every shoot has one now." />
        <Row icon={Scissors} title="Confirm your cull" text="Every home has a photo cap by size (50 / 65 / 80–85). Front max 4, back max 5, bedrooms 2, baths 1–2. Every room gets at least one HERO shot — the best angle of that room; the exterior gets one front and one back. 5-bracket JPG only. Overages come out of pay at $1/photo — because we pay to edit photos we never deliver." />
        <Row icon={Route} title="Tell us the shot order" text="Shoot front to back. Had to work around a seller or contractor? No problem — just tell us the order you shot, so nobody has to guess what's where." />
        <Row icon={Eraser} title="Note what needs removing" text="Pets, trash cans, vehicles, clutter that couldn't be moved. Move what you can on site — strong attention to detail is the job." />
        <Row icon={Clapperboard} title="Video jobs: confirm the script + leave instructions" text="The script imports from Script Studio — confirm it as written or fix what changed on site. Then your instructions for the edit: the flow, the money shots, your vision. Required on every video job." />
        <Row icon={Upload} title="Check off and submit" text="Tick each deliverable as it lands, add anything the editor should know, submit. You can leave feedback on the process after every job — it goes straight to Jordan." />
      </div>

      <div className="mt-7 rounded-2xl border bg-surface p-4">
        <p className="text-sm leading-relaxed text-foreground/85">
          <CheckCircle2 className="mr-1.5 inline size-4 -translate-y-px text-success" />
          By agreeing you&rsquo;re confirming you&rsquo;ve read the standard and you&rsquo;ll complete the upload
          page for every shoot, the same day. Questions or pushback? Text Kyle or Jordan — this process improves
          with your feedback.
        </p>
        <div className="mt-3.5">
          <AgreeButton />
        </div>
      </div>
    </div>
  );
}

function Row({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border bg-surface p-3.5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{text}</p>
      </div>
    </div>
  );
}
