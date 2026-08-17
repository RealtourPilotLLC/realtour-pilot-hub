import Link from "next/link";
import {
  ArrowLeft, Clapperboard, Clock, ExternalLink, Film, Palette, PlayCircle,
  Sparkles, Timer, Wand2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Section } from "@/components/ui/Section";

export const dynamic = "force-static";

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

type Example = { label: string; url: string };
type VideoType = {
  name: string;
  tier: "standard" | "premium" | "branding";
  style: string[];
  examples: Example[];
  note?: string;
};

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

const TYPES: VideoType[] = [
  {
    name: "Standard Reel",
    tier: "standard",
    style: ["Speed ramps", "Light sound design", "Light transitions", "No crazy effects"],
    examples: [{ label: "Watch the example", url: "https://media.realtourpilot.com/videos/01989067-fd1c-73ae-a19d-c231f9a764be?v=316" }],
  },
  {
    name: "Standard Reel with Agent Intro",
    tier: "standard",
    style: [
      "Speed ramps", "Light sound design", "Light transitions", "No crazy effects",
      "Agent-on-camera intro with kinetic title captions",
    ],
    examples: [{ label: "Watch the example", url: "https://media.realtourpilot.com/videos/019e4ae2-e3de-7223-985a-74ae8f1612e9?v=437" }],
  },
  {
    name: "Standard Cinematic Video",
    tier: "standard",
    style: ["Speed ramps", "Light sound design", "Light transitions", "No crazy effects"],
    examples: [{ label: "Watch the example", url: "https://media.realtourpilot.com/videos/019e6f2b-44e3-7259-bad0-07709cb5940b?v=479" }],
  },
  {
    name: "Personal Branding Reel",
    tier: "branding",
    style: [...STUDIO_910],
    note:
      "These take the longest of anything we make — the kinetic text and titles, the color grade, and the client research + brand asset collection and usage all take real time. Budget the full 7–8 hours and use them.",
    examples: [{ label: "Watch the example", url: "https://media.realtourpilot.com/videos/019e8836-35e4-735c-b144-af78e7e21353?v=326" }],
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
      { label: "Fast-paced — example 1", url: "https://media.realtourpilot.com/videos/01a00c9d-dc90-719c-a26b-1d06dabc474c?v=222" },
      { label: "Fast-paced — example 2", url: "https://media.realtourpilot.com/videos/019fa9fb-5e53-7117-af9d-69b2cbd9cfbd?v=341" },
      { label: "Fast-paced — example 3", url: "https://media.realtourpilot.com/videos/019fab09-c9bc-7275-a013-6b14d73213fd?v=9" },
      { label: "Timeless & Elegant — example 1", url: "https://media.realtourpilot.com/videos/019f681f-4840-7131-90b7-aef2a372c033?v=307" },
      { label: "Timeless & Elegant — example 2", url: "https://media.realtourpilot.com/videos/019dd0a6-6373-7385-863b-581ce5f5c436?v=195" },
    ],
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

export default function VideoStylesPage() {
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

              <div className="mt-3 flex flex-wrap gap-2">
                {v.examples.map((e) => (
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
            </Section>
          );
        })}
      </div>
    </div>
  );
}
