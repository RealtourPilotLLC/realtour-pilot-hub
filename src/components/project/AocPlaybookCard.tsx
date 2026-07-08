import Link from "next/link";
import { BookOpen, Sparkles, GraduationCap, Camera, CheckSquare } from "lucide-react";
import { ink } from "@/components/ui/Badge";

// In-context Agent-on-Camera coaching for a video job — so the crew doesn't have
// to hunt /resources. On the shoot screen it shows the camera-settings cheat sheet
// (straight from the 910 training); everywhere it links the SOP library, the full
// course, and Ask the Hub.
const SETTINGS: { k: string; v: string }[] = [
  { k: "Wide", v: "10–12mm · manual focus @ ∞ · no ND" },
  { k: "Portrait", v: "50mm · autofocus + face-track · variable ND" },
  { k: "Profile", v: "Log / PP8" },
  { k: "Frame rate", v: "60 fps" },
  { k: "Shutter", v: "1/125" },
  { k: "ISO", v: "640 bright · up to 12,800 dark" },
  { k: "Aperture", v: "f8–f22" },
  { k: "White balance", v: "Auto" },
  { k: "Mic gain", v: "−12 (count a phone number to test)" },
];

export function AocPlaybookCard({ context }: { context: "shoot" | "edit" }) {
  return (
    <div className="panel-shadow overflow-hidden rounded-2xl border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg" style={{ background: "#f9731622", color: ink("#f97316") }}>
          <Camera className="size-4" />
        </span>
        <h2 className="text-sm font-semibold">Agent-on-Camera playbook</h2>
      </div>
      <div className="space-y-3 p-4">
        {context === "shoot" && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Camera cheat sheet</div>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {SETTINGS.map((s) => (
                <div key={s.k} className="flex items-baseline justify-between gap-2 border-b border-border/50 py-0.5">
                  <dt className="shrink-0 text-xs text-muted-2">{s.k}</dt>
                  <dd className="text-right text-xs font-medium text-foreground/90">{s.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {context === "edit" && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Reel QC before delivery</div>
            <ul className="space-y-1 text-xs text-foreground/85">
              {[
                "Hook lands in the first 3 seconds",
                "Captions clear of the safe zones (top & bottom)",
                "Agent stayed on script",
                "Song matches the script's energy",
                "Audio clean — levels consistent, no clipping",
              ].map((x) => (
                <li key={x} className="flex items-start gap-1.5"><CheckSquare className="mt-0.5 size-3.5 shrink-0 text-muted-2" /> {x}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[11px] text-muted-2">
          {context === "shoot"
            ? "Lock the hook, script & song before you press record. Review every shot on sight; mark the best take."
            : "Match the song to the script. Hook lands in the first 3 seconds. Keep captions clear of the safe zones."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/resources" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            <BookOpen className="size-3.5" /> SOP library
          </Link>
          <Link href="/training" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            <GraduationCap className="size-3.5" /> Full course
          </Link>
          <Link href="/assistant" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            <Sparkles className="size-3.5" /> Ask the Hub
          </Link>
        </div>
      </div>
    </div>
  );
}
