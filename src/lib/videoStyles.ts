// ---------------------------------------------------------------------------
// THE VIDEO TYPES — one authoritative list of what we cut, its tier, style
// requirements, and live example links. Jordan's spec (Aug 14 2026). Shared by:
//   · the Style Guide page (/resources/video-styles — renders example players)
//   · the editor brief's "What to make" section (/edit/[id] — Jordan: "notes
//     about the type of video should be on the editing page in the What to
//     make section, with examples")
// NO pricing here, ever — creatives read both surfaces.
// ---------------------------------------------------------------------------

export type StyleExample = { label: string; url: string };

export const VIDEO_TIER = {
  standard: { label: "Standard", color: "#38bdf8", edit: "~2 hours to edit", turnaround: "Next-day delivery" },
  premium: { label: "Premium", color: "#a78bfa", edit: "4–6 hours to edit", turnaround: "3-day turnaround" },
  branding: { label: "Personal Branding", color: "#f59e0b", edit: "7–8 hours to edit", turnaround: "Monthly social schedule" },
} as const;

// The Studio 910 treatment, spelled out once — premium + personal branding
// share it, and "go all out" should mean the same list to every editor.
export const STUDIO_910 = [
  "Effects & creative transitions", "SFX & VFX", "Graphics", "Color grading",
  "Masking", "Kinetic text & titles",
];

export type VideoStyleType = {
  name: string;
  tier: keyof typeof VIDEO_TIER;
  style: string[];
  examples: StyleExample[];
  note?: string;
};

export const VIDEO_TYPES: VideoStyleType[] = [
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

// Which type a deliverable is — from its label + whether the JOB is a monthly
// personal-branding engagement (isMonthlyContentJob is the real signal for
// that; labels alone lie, see editors.ts). Falls back to Standard Reel.
export function videoTypeForDeliverable(label: string | null | undefined, monthly: boolean): VideoStyleType {
  const l = (label ?? "").toLowerCase();
  const byName = (n: string) => VIDEO_TYPES.find((t) => t.name === n)!;
  if (monthly || /personal.?brand|branding/.test(l)) return byName("Personal Branding Reel");
  if (/premium|influencer/.test(l)) return byName("Premium Social Media Reel");
  if (/cinematic|horizontal/.test(l)) return byName("Standard Cinematic Video");
  if (/intro|agent/.test(l)) return byName("Standard Reel with Agent Intro");
  return byName("Standard Reel");
}
