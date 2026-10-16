import type { VideoListRow } from "@/lib/contentVideos";

// ---------------------------------------------------------------------------
// WHERE A VIDEO IN PRODUCTION IS, AND WHEN TO EXPECT IT (Oct 15 2026,
// lib/programWatch.portalExpectedFor). "Being edited. Expected by Tue, Oct
// 20." When the date moved, the old date and the plain reason sit beside the
// new one; when it is behind with no new date, it says so and promises
// nothing. The words arrive finished from the server (client words only).
// ---------------------------------------------------------------------------

export function ExpectedLine({ e }: { e: NonNullable<VideoListRow["expected"]> }) {
  return (
    <p className="mt-1 text-[11px] leading-snug text-muted">
      <span className="font-semibold text-foreground/80">{e.stage}.</span>{" "}
      <span className={e.late || e.movedFrom ? "font-medium text-foreground/80" : undefined}>{e.line}</span>
      {e.movedFrom && <span> (was {e.movedFrom})</span>}
      {e.line.endsWith(".") ? "" : "."}
      {e.reason && <span className="block">{e.reason}</span>}
    </p>
  );
}
