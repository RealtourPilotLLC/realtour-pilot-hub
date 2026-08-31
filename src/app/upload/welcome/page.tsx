import { BadgeDollarSign, CheckCircle2, FolderOpen, Scissors, Route, Eraser, Clapperboard, Upload } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AgreeButton } from "@/components/upload/AgreeButton";

export const dynamic = "force-dynamic";

// One-time onboarding for the new upload process (Jordan, Sep 1 2026). The
// 7 PM shoot text links here on first visit; after "I agree" the photographer
// lands on /upload and never sees this page again unless they come back.
export default async function UploadWelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Only ever bounce back inside the upload portal — no open redirects.
  const dest = next && next.startsWith("/upload") ? next : "/upload";
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

      <h2 className="mt-7 text-lg font-semibold">How it works — step by step</h2>
      <p className="mt-1 text-sm text-muted">
        The upload page walks you through these in order. Nothing here is new work — it&rsquo;s the professional
        wrap-up of the shoot you just did, written down once so nobody has to chase you for it later.
      </p>
      <div className="mt-3 space-y-2.5">
        <Row icon={FolderOpen} title="1 · Upload your files to Dropbox" text="Exactly like always: raw photos into Raw Photos, raw video into Raw Video. What's new is the Backup Photos folder — that's where your culled extras go (the alternate hero shot, the backup exterior angle). Backup photos are kept, but they never get edited or delivered. The page shows you all three folders with live file counts so you can confirm everything landed." />
        <Row icon={Scissors} title="2 · Cull to the standard, then confirm it" text="Every home has a target gallery range based on its size — the page shows you this home's exact numbers (for example 'aim for 45–55 finals, 60 is the ceiling'). Cull before you upload: every space gets one HERO shot (the photo you'd pick if you could only show one), no duplicate angles at different distances, and every photo has to show something new. Then you tick four boxes — Coverage, Culling, Quality, Count — to confirm the gallery is right. A $1 production charge may apply per clearly unnecessary photo, but you're never charged for photos a property genuinely needed." />
        <Row icon={Route} title="3 · Tell us the order you shot" text="Two taps if you shot the standard way: front to back, or interior front-to-back then exterior. If a seller, a contractor, or the agent forced a different order, that's completely fine — just pick 'Different order' and type the order you went in. Without this, someone who has never been inside the house spends an hour guessing which bedroom is which." />
        <Row icon={Eraser} title="4 · Note what the editor needs to remove" text="List anything that couldn't be moved on site and needs to come out in editing — trash cans, pet bowls, a car in the driveway. If the scene was clean, just tick 'Nothing needs removal — I checked.' One of the two is required, so the editor never has to guess." />
        <Row icon={Clapperboard} title="5 · Video shoots: confirm the script + brief the editor" text="If the shoot had a video, the script the agent was supposed to read imports automatically. Confirm it was delivered as written — or fix the text right there if anything changed on site, so the editor cuts to the real words. Then fill in the edit brief: your vision, the must-show shots, areas to avoid, what the realtor asked for, and pick the edit style (Fast-Paced, or Timeless & Elegant). The camera color profile goes to the editor automatically. Vision and style are required on every video job." />
        <Row icon={Upload} title="6 · Check off and submit" text="Tick each deliverable as its files land in Dropbox, add anything else the editor should know, and hit submit. That single tap notifies the editors, builds the editor brief, and closes out your job. Afterward there's an optional feedback box — anything you'd change about this process goes straight to Jordan." />
        <Row icon={BadgeDollarSign} title="Your pay rides on the submit" text="Once submitted, the shoot is added to your payroll — you'll see it in My Pay right away. A shoot that's uploaded but never submitted doesn't show up in My Pay, because the job isn't done until the page is done." />
      </div>

      <a
        href="/resources/photography-sop"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 block rounded-2xl border border-brand/30 bg-brand-soft/40 px-4 py-3 text-sm font-semibold text-brand transition-colors hover:bg-brand-soft"
      >
        Read the full Photography SOP — shooting, culling &amp; upload standards ↗
      </a>

      <div className="mt-7 rounded-2xl border bg-surface p-4">
        <p className="text-sm leading-relaxed text-foreground/85">
          <CheckCircle2 className="mr-1.5 inline size-4 -translate-y-px text-success" />
          By agreeing you&rsquo;re confirming you&rsquo;ve read the Photography SOP and this page, and that
          you&rsquo;ll complete the upload page for every shoot, the same day. Questions or pushback? Text Kyle or
          Jordan — this process improves with your feedback.
        </p>
        <div className="mt-3.5">
          <AgreeButton next={dest} />
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
