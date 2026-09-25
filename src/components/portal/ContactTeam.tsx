import Link from "next/link";
import { MessageSquare, MessageCircle, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// CONTACTING THE OFFICE (CP-13, Sep 24 2026).
//
// The audit counted about eighteen client-facing sentences that said "text us"
// and not one of them carried a number or a link: the footer, the paused
// notice, the empty Resources page, every player error. A client stuck on any
// of them had to already know how to reach us. This file is the one answer:
//
//   · a signed-in client (or the link) who MAY message gets "Message Kyle",
//     which opens the program conversation on the Messages tab;
//   · everyone, including a paused or ended account that can no longer
//     message, gets the office line as a real tel: and sms: link.
//
// No "use client" and no server imports, on purpose: the client components
// (the player, the cut review) import the default below for their own error
// sentences, and the server pages render the card. The name and number are an
// owner-editable AppSetting, `portal-contact` (programMessages.portalContact);
// this default is what a missing row means. Jordan, Sep 24: Kyle, (215) 645-4889
// — the same line reviewWindows.URGENT_CONTACT and the scheduler already print.
// ---------------------------------------------------------------------------

export type PortalContact = {
  /** First name as the client should read it. */
  name: string;
  /** "(215) 645-4889" — what the page prints. */
  display: string;
  /** "+12156454889" — what tel: and sms: dial. */
  e164: string;
};

export const DEFAULT_PORTAL_CONTACT: PortalContact = { name: "Kyle", display: "(215) 645-4889", e164: "+12156454889" };

/** "call or text Kyle at (215) 645-4889" — for a sentence that cannot hold a link. */
export const contactLine = (c: PortalContact = DEFAULT_PORTAL_CONTACT) => `call or text ${c.name} at ${c.display}`;

/**
 * The contact card: the program conversation when this viewer may use it, and
 * the office line always. `messagesHref` null = this viewer cannot message
 * (view-only seat, paused or ended program), so only the line is offered.
 */
export function ContactTeam({ contact, messagesHref, note, className }: {
  contact: PortalContact;
  messagesHref: string | null;
  /** One sentence above the actions, e.g. why messaging is off. */
  note?: string | null;
  className?: string;
}) {
  const btn = "inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
  return (
    <div className={cn("rounded-2xl border border-border bg-surface/70 p-4 text-sm", className)}>
      <div className="font-semibold">Questions or topic ideas?</div>
      <p className="mt-0.5 text-xs text-muted">
        {note ?? (messagesHref ? `Message ${contact.name} here and the reply comes back to this page. For anything inside 24 hours, call or text.` : `Call or text ${contact.name} at ${contact.display}.`)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {messagesHref && (
          <Link href={messagesHref} className={cn(btn, "border-brand/30 bg-brand text-white hover:opacity-90")}>
            <MessageSquare className="size-4" /> Message {contact.name}
          </Link>
        )}
        <a href={`tel:${contact.e164}`} className={cn(btn, "border-border bg-surface hover:bg-surface-2")} aria-label={`Call ${contact.name} at ${contact.display}`}>
          <Phone className="size-4 text-brand" /> Call {contact.display}
        </a>
        <a href={`sms:${contact.e164}`} className={cn(btn, "border-border bg-surface hover:bg-surface-2")} aria-label={`Text ${contact.name} at ${contact.display}`}>
          <MessageCircle className="size-4 text-brand" /> Text
        </a>
      </div>
    </div>
  );
}
