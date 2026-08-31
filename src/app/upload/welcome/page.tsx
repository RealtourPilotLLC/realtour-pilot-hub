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
        <p className="text-sm font-semibold">Why we&rsquo;re doing this</p>
        <p className="mt-1 text-sm leading-relaxed text-foreground/85">
          It&rsquo;s not to make your job harder. It&rsquo;s so every client gets our best — because that&rsquo;s how we:
        </p>
        <ul className="mt-2 space-y-1 text-sm text-foreground/85">
          <li>· Keep growing and landing more business</li>
          <li>· Keep you busy with more shoots</li>
          <li>· Stay aligned as a team on every job</li>
        </ul>
        <p className="mt-2 text-sm font-semibold text-foreground/85">Presentation is everything.</p>
      </div>

      <h2 className="mt-7 text-lg font-semibold">How it works — step by step</h2>
      <p className="mt-1 text-sm text-muted">
        The upload page walks you through these in order. Nothing here is new work — it&rsquo;s the professional
        wrap-up of the shoot you just did, written down once so nobody has to chase you for it later.
      </p>
      <div className="mt-3 space-y-2.5">
        <Row icon={FolderOpen} title="1 · Upload your files to Dropbox" points={[
          "Raw photos into Raw Photos, raw video into Raw Video — exactly like always.",
          "NEW: your culled extras (alternate hero shots, backup angles) go in the Backup Photos folder.",
          "Backup photos are kept, but never edited or delivered.",
          "The page shows live file counts for all three folders, so you can confirm everything landed.",
        ]} />
        <Row icon={Scissors} title="2 · Cull to the standard, then confirm it" points={[
          "The page shows this home's exact target — e.g. \u201caim for 45\u201355 finals, 60 is the ceiling\u201d — and the ceiling is not a goal.",
          "One HERO shot per space \u00b7 one composition, once \u00b7 every photo must add new information.",
          "Confirm four boxes before you submit: Coverage \u00b7 Culling \u00b7 Quality \u00b7 Count.",
          "A $1 production charge may apply per clearly unnecessary photo — never for photos the property genuinely needed.",
        ]} />
        <Row icon={Route} title="3 · Tell us the order you shot" points={[
          "Standard orders are two taps: Front to back, or Interior front-to-back, then exterior.",
          "Had to work around a seller, contractor, or the agent? Totally fine — just type the order you went in.",
          "Why it matters: organizing photos of a house we've never been inside burns hours of office time — and presentation matters.",
        ]} />
        <Row icon={Eraser} title="4 · Note what the editor needs to remove" points={[
          "List anything that couldn't be moved on site — trash cans, pet items, a car in the driveway.",
          "Scene was clean? Tick \u201cNothing needs removal — I checked.\u201d",
          "One of the two is required, so the editor never has to guess.",
        ]} />
        <Row icon={Clapperboard} title="5 · Video shoots: script + edit brief" points={[
          "The script the agent read imports automatically — confirm it was delivered as written, or fix the text if anything changed on site.",
          "Brief the editor in sections: your vision, must-show shots, areas to avoid, realtor requests, extra notes.",
          "Pick the edit style: Fast-Paced, or Timeless & Elegant (Cinematic).",
          "The color profile (S-Log3, D-LogM) goes to the editor automatically. Vision + style are required.",
        ]} />
        <Row icon={Upload} title="6 · Check off and submit" points={[
          "Tick each deliverable as its files land in Dropbox, add anything else the editor should know.",
          "One tap on submit notifies the editors and builds the editor brief — that's the job closed out.",
          "Afterward there's an optional feedback box — anything you'd change goes straight to Jordan.",
        ]} />
        <Row icon={BadgeDollarSign} title="Your pay rides on the submit" points={[
          "Once submitted, the shoot is added to your payroll — you'll see it in My Pay right away.",
          "Uploaded but never submitted? It doesn't show in My Pay — the job isn't done until the page is done.",
        ]} />
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

function Row({ icon: Icon, title, points }: { icon: LucideIcon; title: string; points: string[] }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border bg-surface p-3.5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <ul className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-muted">
          {points.map((pt, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-brand">·</span>
              <span>{pt}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
