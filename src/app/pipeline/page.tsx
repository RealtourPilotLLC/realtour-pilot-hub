import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /pipeline (the old Project Tracker, Kyle's delivery board) is SHOOTS now
// (Oct 19 2026, /jobs): the same jobs and the same due dates, with where the
// photos and the video stand side by side and the client's open requests.
// The program videos' milestones moved with it (Shoots → Monthly). Old links,
// bookmarks and bells land there; ?test=1 is carried over. The program watch
// actions (./actions.ts) stay here and are called from the Monthly view.
// ---------------------------------------------------------------------------

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  const test = (await searchParams)?.test === "1";
  redirect(test ? "/jobs?test=1" : "/jobs");
}
