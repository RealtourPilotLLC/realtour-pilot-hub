import { redirect } from "next/navigation";

// Client texts moved onto the Communications "Outbox" tab (Jordan: "keep comms
// all in one tab"). This route survives only so old links keep working.
export default function TextsPage() {
  redirect("/communications?tab=outbox");
}
