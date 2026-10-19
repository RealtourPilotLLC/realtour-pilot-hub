import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/messages: a door, not a page, since Oct 19 2026 (night). Jordan
// approved "Messages merges Communications and Client messages into one
// inbox". What this page showed (every client waiting on a reply, texts and
// email together, oldest first, with Reply and Handled, and the new leads) is
// the first view of /communications now, "Waiting on us", from the same read
// (lib/opsHome.messagesBoard). Old links, bells, Slack lines and the Home's
// summary box land there; the test view (?test=1) rides along.
// ---------------------------------------------------------------------------

export default async function MessagesDoor(props: { searchParams?: Promise<{ test?: string | string[] }> }) {
  const sp = await (props?.searchParams ?? Promise.resolve(undefined));
  redirect(sp?.test === "1" ? "/communications?test=1" : "/communications");
}
