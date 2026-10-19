import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/video-delivery MOVED INTO THE VIDEO REVIEW ROOM (Jordan, Oct 19 2026:
// "I think all of this could be in the review room, maybe change review room
// name to video review room"). Ready to send, Late, Due today, In revision and
// Coming up are sections of /review now. Old links (Slack messages, Kyle's
// cards, bookmarks) land there.
// ---------------------------------------------------------------------------

export default function VideoDeliveryMoved(): never {
  redirect("/review");
}
