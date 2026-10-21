import { MessageSquare } from "lucide-react";
import type { ThreadMessage } from "@/lib/programMessages";
import { Card, LoadFailed, tzShort } from "@/components/portal/ui";
import { ContactTeam, type PortalContact } from "@/components/portal/ContactTeam";
import { MessageComposer } from "@/components/portal/MessageComposer";
import { cn } from "@/lib/utils";

// MESSAGES (CP-13): the client's one conversation with the office. Oldest at
// the top, the box at the bottom, the office's words on the left and the
// client's on the right — the shape of every messaging app they already use.
// What it is NOT is said once, under the box: changes to a video go on the
// video, where the editor gets them.

export type MessagesTabData = {
  messages: ThreadMessage[];
  /** Replies the page counted as new before it marked them read. */
  unreadBefore: number;
  ownerFirst: string;
  canMessage: boolean;
  /** Why the box is missing, when it is (view-only seat, paused/ended program). */
  refusal: string | null;
  contact: PortalContact;
  hint: string;
  /** Oct 6 2026: the box's starting words when the visit came from the portal notice's "Tell us" (?about=portal). */
  prefill?: string;
  /** Oct 20 2026 (audit E19): the label this viewer's own messages carry (portalAccess.actorLabel), shown as "You". */
  youLabel?: string | null;
};

// Audit E19: every other portal time names its zone; these do too.
const when = (iso: string) => `${new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ${tzShort("America/New_York", new Date(iso))}`;
/** A client message's byline: "You" for this viewer's own, else the name. The
 *  shared link's messages are stamped "<Client> (portal)" for the office; the
 *  client never needs to read that suffix. */
const byline = (label: string, you: string | null | undefined) => (you && label === you ? "You" : label.replace(/\s*\(portal\)$/, ""));

export function MessagesTab({ d, failed }: { d: MessagesTabData | null; failed: boolean }) {
  if (failed) return <div className="mt-6"><LoadFailed what="your messages" /></div>;
  if (!d) return null;
  const lastStaff = [...d.messages].reverse().find((m) => m.authorKind === "STAFF") ?? null;
  const firstNew = d.unreadBefore > 0 ? d.messages.filter((m) => m.authorKind === "STAFF").slice(-d.unreadBefore)[0]?.id ?? null : null;
  return (
    <div className="mt-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Messages</h1>
        <p className="mt-0.5 text-xs text-muted">Your conversation with {d.ownerFirst} and the Realtour Pilot team. Replies come back here.</p>
      </div>
      <Card>
        {d.messages.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted">
            <MessageSquare className="mx-auto size-6 text-muted-2" />
            <p className="mt-2">No messages yet. Ask {d.ownerFirst} anything about your program.</p>
          </div>
        ) : (
          <ol className="space-y-3" aria-label="Conversation">
            {d.messages.map((m) => {
              const office = m.authorKind === "STAFF";
              return (
                <li key={m.id} id={`m-${m.id}`} className={cn("flex flex-col", office ? "items-start" : "items-end")}>
                  {m.id === firstNew && <div className="mb-2 w-full border-t border-brand/40 pt-1 text-center text-[10px] font-semibold uppercase tracking-widest text-brand">New</div>}
                  <div className={cn("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm", office ? "rounded-tl-md border border-border bg-surface" : "rounded-tr-md bg-brand-action text-white")}>
                    {m.body}
                  </div>
                  <div className="mt-1 px-1 text-[11px] text-muted-2">
                    {office ? `${m.authorLabel.split(/\s+/)[0]} · Realtour Pilot` : byline(m.authorLabel, d.youLabel)} · {when(m.createdAtISO)}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
      {d.canMessage ? (
        <Card>
          <MessageComposer replyToId={lastStaff?.id ?? null} ownerFirst={d.ownerFirst} hint={d.hint} initialBody={d.prefill} />
        </Card>
      ) : (
        <ContactTeam contact={d.contact} messagesHref={null} note={d.refusal} />
      )}
    </div>
  );
}
