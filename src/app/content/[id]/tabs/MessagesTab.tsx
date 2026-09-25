import { ProgramMessagesPanel } from "@/components/content/ProgramMessagesPanel";
import type { TabCtx } from "./shared";

// ---------------------------------------------------------------------------
// MESSAGES (UI-02, CP-13) — the program conversation, with the client's texts
// (OpenPhone) and emails (Gmail) underneath, each labelled by channel. Opening
// the tab marks the thread read for the person looking — never for the client.
// ---------------------------------------------------------------------------

export async function MessagesTab({ ctx }: { ctx: TabCtx }) {
  const pmsg = await import("@/lib/programMessages");
  const d = await pmsg.staffMessagesTab(ctx.id, { id: ctx.me?.id ?? null }).catch(() => null);
  if (d && ctx.me?.id) await pmsg.markThreadRead(ctx.id, `au:${ctx.me.id}`).catch(() => {});
  return d ? <ProgramMessagesPanel d={d} /> : <p className="text-sm text-warning">Couldn&rsquo;t load the conversation — refresh to try again.</p>;
}
