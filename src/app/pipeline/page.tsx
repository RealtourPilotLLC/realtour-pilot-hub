import { PageHeader } from "@/components/PageHeader";
import { DeliveryBoardView } from "@/components/tracker/DeliveryBoardView";
import { deliveryBoard } from "@/lib/deliveryBoard";

export const dynamic = "force-dynamic";

// PROJECT TRACKER — rebuilt as a delivery board.
//
// Jordan: "I want a screen that our content delivery / quality checking person
// AKA Kyle can come in to and see what projects we have due today, what is
// holding them up, and what is upcoming."
//
// The old page was a sortable spreadsheet of every job in the last fortnight.
// It could answer any question if you knew which column to read — which is the
// same as answering none of them at a glance. This one answers three, and the
// tabs ARE the three questions.
//
// Due dates come from the real per-product promises in src/lib/turnaround.ts,
// not one flat SLA: photos and floor plans next day, standard video in 48h,
// premium reels in 3-4 days, the monthly social packages in 7-10 BUSINESS days.

export default async function PipelinePage() {
  const board = await deliveryBoard();
  const live = board.today.length + board.tomorrow.length + board.upcoming.length;

  return (
    <div>
      <PageHeader
        title="Project Tracker"
        subtitle={`${live} in production · ${board.today.length} due today${
          board.overdueCount ? ` · ${board.overdueCount} past due` : ""
        }`}
      />
      <div className="mx-auto max-w-4xl p-4 pb-16 sm:p-6">
        <DeliveryBoardView board={board} />
      </div>
    </div>
  );
}
