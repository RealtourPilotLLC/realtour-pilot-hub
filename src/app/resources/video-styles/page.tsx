import Link from "next/link";
import {
  AlertTriangle, ArrowLeft, Clapperboard, Clock, ExternalLink, Film, FolderDown,
  GraduationCap, ListMusic, Mic, MonitorPlay, Music, Palette, PlayCircle,
  Sparkles, Timer, Wand2, Wrench,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Section } from "@/components/ui/Section";

// ---------------------------------------------------------------------------
// VIDEO STYLE GUIDE — the editors' reference page.
//
// Jordan: "I want this page to be accessible to anyone, but it's really for
// the editors to know what type of video they are editing, what the
// specifications are, what examples look like, and what we expect in terms of
// turnaround and effort."
//
// Lives under /resources so every role's default access covers it (middleware
// resolves /resources/* to the `resources` PageKey). All copy below is
// Jordan's spec, 14 Aug 2026 — examples are live delivery links on
// media.realtourpilot.com. NO pricing on this page, ever: editors and
// photographers see it, and creatives never see client prices.
//
// The turnaround chips are the INTERNAL bar, which is deliberately tighter
// than the client promise in src/lib/turnaround.ts (premium: internal 3 days
// vs promised 3–4) — finishing on the internal bar is what keeps the buffer.
// ---------------------------------------------------------------------------

// Examples play INLINE (Jordan: "make it show the videos in a player
// carousel"). The delivery pages are Aryeo pages backed by Mux: each page's
// <video> tag carries data-hls-video-stream="https://stream.mux.com/<id>.m3u8",
// and this account has MP4 renditions enabled (verified: /high.mp4 answers 206,
// image.mux.com thumbnails answer 200). So we resolve each example page to its
// Mux playback id at render time and hand a native <video> the /high.mp4 +
// thumbnail poster — no iframe, no hls.js. Daily ISR keeps the ids fresh if
// Aryeo ever re-encodes; any page that fails to resolve falls back to the
// plain "watch" link, so a bad fetch degrades to what we shipped before.
export const revalidate = 86400;

type Example = { label: string; url: string };
type Resolved = Example & { mp4?: string; poster?: string; vertical?: boolean };

async function resolveExample(e: Example): Promise<Resolved> {
  try {
    const res = await fetch(e.url, { next: { revalidate: 86400 }, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return e;
    const html = await res.text();
    const id = html.match(/data-hls-video-stream="https:\/\/stream\.mux\.com\/([A-Za-z0-9]+)\.m3u8/)?.[1];
    if (!id) return e;
    const h = Number(html.match(/property="og:video:height" content="(\d+)/)?.[1] ?? 0);
    const w = Number(html.match(/property="og:video:width" content="(\d+)/)?.[1] ?? 0);
    return {
      ...e,
      mp4: `https://stream.mux.com/${id}/high.mp4`,
      poster: `https://image.mux.com/${id}/thumbnail.jpg?time=1`,
      vertical: h > w,
    };
  } catch {
    return e; // network hiccup → the link-out fallback renders instead
  }
}

const TIER = {
  standard: { label: "Standard", color: "#38bdf8", edit: "~2 hours to edit", turnaround: "Next-day delivery" },
  premium: { label: "Premium", color: "#a78bfa", edit: "4–6 hours to edit", turnaround: "3-day turnaround" },
  branding: { label: "Personal Branding", color: "#f59e0b", edit: "7–8 hours to edit", turnaround: "Monthly social schedule" },
} as const;

// The Studio 910 treatment, spelled out once — premium + personal branding
// share it, and "go all out" should mean the same list to every editor.
const STUDIO_910 = [
  "Effects & creative transitions", "SFX & VFX", "Graphics", "Color grading",
  "Masking", "Kinetic text & titles",
];

type VideoType = {
  name: string;
  tier: keyof typeof TIER;
  style: string[];
  examples: Example[];
  note?: string;
};

const TYPES: VideoType[] = [
  {
    name: "Standard Reel",
    tier: "standard",
    style: ["Speed ramps", "Light sound design", "Light transitions", "No crazy effects"],
    examples: [{ label: "Example", url: "https://media.realtourpilot.com/videos/01989067-fd1c-73ae-a19d-c231f9a764be?v=316" }],
  },
  {
    name: "Standard Reel with Agent Intro",
    tier: "standard",
    style: [
      "Speed ramps", "Light sound design", "Light transitions", "No crazy effects",
      "Agent-on-camera intro with kinetic title captions",
    ],
    examples: [{ label: "Example", url: "https://media.realtourpilot.com/videos/019e4ae2-e3de-7223-985a-74ae8f1612e9?v=437" }],
  },
  {
    name: "Standard Cinematic Video",
    tier: "standard",
    style: ["Speed ramps", "Light sound design", "Light transitions", "No crazy effects"],
    examples: [{ label: "Example", url: "https://media.realtourpilot.com/videos/019e6f2b-44e3-7259-bad0-07709cb5940b?v=479" }],
  },
  {
    name: "Personal Branding Reel",
    tier: "branding",
    style: [...STUDIO_910],
    note:
      "These take the longest of anything we make — the kinetic text and titles, the color grade, and the client research + brand asset collection and usage all take real time. Budget the full 7–8 hours and use them.",
    examples: [{ label: "Example", url: "https://media.realtourpilot.com/videos/019e8836-35e4-735c-b144-af78e7e21353?v=326" }],
  },
  {
    name: "Premium Social Media Reel",
    tier: "premium",
    style: [
      ...STUDIO_910,
      "Storytelling", "Ryan Nangle transitions", "Best color possible",
      "Best clips only", "Best flow",
    ],
    note:
      "Premium comes in more than one voice — match the energy to the listing and the agent. Two lanes we cut in today:",
    examples: [
      { label: "Fast-paced 1", url: "https://media.realtourpilot.com/videos/01a00c9d-dc90-719c-a26b-1d06dabc474c?v=222" },
      { label: "Fast-paced 2", url: "https://media.realtourpilot.com/videos/019fa9fb-5e53-7117-af9d-69b2cbd9cfbd?v=341" },
      { label: "Fast-paced 3", url: "https://media.realtourpilot.com/videos/019fab09-c9bc-7275-a013-6b14d73213fd?v=9" },
      { label: "Timeless & Elegant 1", url: "https://media.realtourpilot.com/videos/019f681f-4840-7131-90b7-aef2a372c033?v=307" },
      { label: "Timeless & Elegant 2", url: "https://media.realtourpilot.com/videos/019dd0a6-6373-7385-863b-581ce5f5c436?v=195" },
    ],
  },
];

// Music: the premium/personal-branding sound. Jordan, verbatim intent: real
// copyrighted music, used for personal-use-only social content; start from the
// playlists but editors are encouraged to pick a song they think fits better.
const PLAYLISTS = [
  { name: "Houses", url: "https://open.spotify.com/playlist/3a29wPujeTmSJO21Ei2VgL" },
  { name: "Real Estate", url: "https://open.spotify.com/playlist/3TuLtYWWRUVmEuP1fXxGBx" },
];

const TOOLS = [
  {
    name: "Editing assets — LUTs, SFX & Ryan Nangle plugins",
    url: "https://www.dropbox.com/scl/fo/6u6kpe2ja9ve2y0h1n5nj/AOA24-gNmQqxtpmRWyAV3M4?rlkey=1lfnhinvlgsep59inepz5251u&st=p4movele&dl=0",
    icon: FolderDown,
    what: "The shared \"Video Editing Assets\" Dropbox: LUTs for the color grade, our SFX library, and the Ryan Nangle transition plugins. Download once and install locally.",
  },
  {
    name: "Adobe Podcast AI — Enhance Speech",
    url: "https://podcast.adobe.com/enhance",
    icon: Mic,
    what: "Clean up agent-on-camera audio before the edit — run the dialogue through Enhance and use the cleaned track.",
  },
  {
    name: "YTMP3 converter",
    url: "https://convertytmp3.org/",
    icon: Music,
    what: "Step 3 of the music workflow: paste the YouTube link, download the MP3, drop it in your timeline.",
  },
];

function TierChips({ tier }: { tier: keyof typeof TIER }) {
  const t = TIER[tier];
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge color={t.color}>{t.label}</Badge>
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
        <Timer className="size-3" /> {t.edit}
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
        <Clock className="size-3" /> {t.turnaround}
      </span>
    </span>
  );
}

// The example strip: a scroll-snap carousel of native players. Vertical reels
// render 9:16, the cinematic examples 16:9, all at one shared height so the
// row reads as a strip. preload="none" — five muxed videos must not download
// on page open; the poster is the weight until someone presses play.
function ExampleCarousel({ examples }: { examples: Resolved[] }) {
  const playable = examples.filter((e) => e.mp4);
  const linksOnly = examples.filter((e) => !e.mp4);
  return (
    <div className="mt-3">
      {playable.length > 0 && (
        <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2">
          {playable.map((e) => (
            <figure key={e.url} className="shrink-0 snap-start">
              <div
                className={`overflow-hidden rounded-xl border border-border bg-black ${e.vertical ? "aspect-[9/16]" : "aspect-video"} h-80`}
              >
                <video
                  src={e.mp4}
                  poster={e.poster}
                  controls
                  playsInline
                  preload="none"
                  className="size-full object-contain"
                />
              </div>
              <figcaption className="mt-1.5 flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-foreground/85">{e.label}</span>
                <a
                  href={e.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-muted hover:text-foreground"
                >
                  Open <ExternalLink className="size-3" />
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {linksOnly.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {linksOnly.map((e) => (
            <a
              key={e.url}
              href={e.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-brand transition hover:border-brand hover:bg-surface-2"
            >
              <PlayCircle className="size-4" /> {e.label}
              <ExternalLink className="size-3 opacity-70" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// The 910 Academy courses that are EDITING training. Matches the creative
// allowlist in src/app/training/page.tsx — everything listed here is visible
// to editors on /training (summaries + full transcripts; the 910 Vimeo links
// are down at the source, so the written material is the value today).
const EDITING_COURSES = ["Editing", "AI Editing", "Viral Editing Masterclass (2025)", "Viral Editing Masterclass (2024)"];

export default async function VideoStylesPage() {
  const trainingLessons = await prisma.trainingLesson.findMany({
    where: { course: { in: EDITING_COURSES } },
    orderBy: [{ courseNo: "asc" }, { orderNo: "asc" }],
    select: { course: true, title: true },
  });
  const modules = EDITING_COURSES
    .map((c) => ({ course: c, lessons: trainingLessons.filter((l) => l.course === c).map((l) => l.title) }))
    .filter((m) => m.lessons.length > 0);

  // Resolve every example to its Mux playback source, concurrently, ISR-cached.
  const resolved = new Map<string, Resolved>(
    (await Promise.all(TYPES.flatMap((t) => t.examples).map(resolveExample))).map((r) => [r.url, r]),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Editor reference"
        title="Video Style Guide"
        subtitle="What you're editing, what it should look like, and how long it should take"
      />
      <div className="mx-auto max-w-3xl space-y-6 p-4 pb-16 sm:p-6">
        <Link href="/resources" className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline">
          <ArrowLeft className="size-4" /> Resources & SOPs
        </Link>

        {/* The three tiers at a glance — effort scales with tier, on purpose. */}
        <Section icon={Film} title="The three tiers">
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(TIER) as (keyof typeof TIER)[]).map((k) => {
              const t = TIER[k];
              return (
                <div key={k} className="rounded-xl border border-border bg-surface-2/40 p-3">
                  <Badge color={t.color}>{t.label}</Badge>
                  <p className="mt-2 flex items-center gap-1.5 text-sm"><Timer className="size-3.5 text-muted" /> {t.edit}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm"><Clock className="size-3.5 text-muted" /> {t.turnaround}</p>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            The sooner a cut is done, the better — always. Standard work is clean, consistent and fast:
            get it right, keep it simple, ship it. Premium and Personal Branding are the opposite end of
            the dial: <strong className="text-foreground">that&rsquo;s where you get to use your creativity,
            put in maximum effort, and create art.</strong>
          </p>
          <p className="mt-2 text-xs text-muted-2">
            The premium turnaround here (3 days) is our internal bar — the client is promised 3–4, and
            finishing on day 3 is what keeps that promise safe.
          </p>
        </Section>

        {/* Editor training walkthrough — Jordan's Loom covering the Project
            Tracker, Dropbox, and how the workflow fits together. Loom's /embed
            path is officially iframeable (verified: no frame-blocking headers;
            oEmbed reports 1280×960, hence the 4:3 box). */}
        <Section icon={MonitorPlay} title="How we work — walkthrough">
          <p className="text-sm leading-relaxed text-muted">
            Jordan&rsquo;s walkthrough for editors: the Project Tracker, our Dropbox setup, and how a
            job moves through the system. Watch this before your first edit.
          </p>
          <div className="mt-3 aspect-[4/3] overflow-hidden rounded-xl border border-border bg-black">
            <iframe
              src="https://www.loom.com/embed/afdf72bee6f747bda671a385105d7e20"
              className="size-full"
              loading="lazy"
              title="Editor walkthrough — Project Tracker, Dropbox & workflow"
              allow="fullscreen"
              allowFullScreen
            />
          </div>
          <a
            href="https://www.loom.com/share/afdf72bee6f747bda671a385105d7e20"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            Open in Loom <ExternalLink className="size-3" />
          </a>
        </Section>

        {/* One card per video type. */}
        {TYPES.map((v) => {
          const Icon = v.tier === "standard" ? Clapperboard : v.tier === "premium" ? Sparkles : Palette;
          return (
            <Section key={v.name} icon={Icon} title={v.name}>
              <TierChips tier={v.tier} />

              <div className="mt-3 flex flex-wrap gap-1.5">
                {v.style.map((s) => (
                  <span key={s} className="rounded-lg border border-border bg-surface-2/60 px-2 py-1 text-xs font-medium text-foreground/85">
                    {s}
                  </span>
                ))}
              </div>

              {(v.tier === "premium" || v.tier === "branding") && (
                <p className="mt-3 inline-flex items-start gap-1.5 text-sm text-muted">
                  <Wand2 className="mt-0.5 size-3.5 shrink-0 text-brand" />
                  <span>Go all out — the full Studio 910 treatment. This is the work that builds the brand.</span>
                </p>
              )}

              {v.note && <p className="mt-2 text-sm leading-relaxed text-muted">{v.note}</p>}

              <ExampleCarousel examples={v.examples.map((e) => resolved.get(e.url) ?? e)} />
            </Section>
          );
        })}

        {/* Editing training — the 910 Academy modules, live from the hub's
            training library. Links into /training, where every lesson has an
            AI summary + full transcript. */}
        {modules.length > 0 && (
          <Section icon={GraduationCap} title="Editing training">
            <p className="text-sm leading-relaxed text-muted">
              The 910 Academy editing modules — summaries and full transcripts live on the{" "}
              <Link href="/training" className="text-brand hover:underline">Training</Link> page.
              The Viral Editing Masterclass is the closest thing we have to a course on the
              premium/Studio-910 style.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {modules.map((m) => (
                <Link
                  key={m.course}
                  href="/training"
                  className="rounded-xl border border-border bg-surface-2/40 p-3 transition hover:border-brand"
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                    {m.course}
                    <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">
                      {m.lessons.length} lesson{m.lessons.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {m.lessons.join(" · ")}
                  </span>
                </Link>
              ))}
            </div>
          </Section>
        )}

        {/* Music — the premium/personal-branding sound. */}
        <Section icon={ListMusic} title="Music">
          <p className="text-sm leading-relaxed text-muted">
            Premium reels and Personal Branding cut to real, copyrighted music — used for
            personal-use-only social content. Start from the playlists below, and you&rsquo;re
            encouraged to pick a song you think fits the video better — the right track is part
            of the craft.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {PLAYLISTS.map((p) => (
              <a
                key={p.url}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-brand transition hover:border-brand hover:bg-surface-2"
              >
                <ListMusic className="size-4" /> {p.name} — Spotify
                <ExternalLink className="size-3 opacity-70" />
              </a>
            ))}
          </div>

          {/* The hard rules — a wrong song choice lands on a CLIENT's listing. */}
          <div className="mt-4 rounded-xl border border-warning/40 bg-warning-soft/40 p-3">
            <p className="flex items-start gap-2 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                <strong>Before you commit to a song:</strong> no bad language, nothing sexual, and
                nothing that could sound bad or reflect negatively on the home. When in doubt,
                pick something else — the track sits on a client&rsquo;s listing.
              </span>
            </p>
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Getting the track</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-foreground/85">
              <li>Find the song on one of the playlists (or your own pick that fits the rules above).</li>
              <li>Search the song on YouTube and copy the video link.</li>
              <li>
                Paste it into{" "}
                <a href="https://convertytmp3.org/" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                  convertytmp3.org
                </a>{" "}
                and download the MP3.
              </li>
            </ol>
          </div>
        </Section>

        {/* Tools we use. */}
        <Section icon={Wrench} title="Tools">
          <ul className="space-y-3">
            {TOOLS.map((t) => (
              <li key={t.url}>
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-3 rounded-xl border border-border bg-surface-2/40 p-3 transition hover:border-brand"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand">
                    <t.icon className="size-4.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      {t.name} <ExternalLink className="size-3 text-muted-2" />
                    </span>
                    <span className="mt-0.5 block text-sm text-muted">{t.what}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
