import "server-only";
import { prisma } from "@/lib/prisma";
import type { ConvoTurn } from "@/lib/integrations/ai";

// ---------------------------------------------------------------------------
// THE ONE EMAIL REPLY DRAFTER. The client page's "Draft reply" (ClientEmails,
// app/clients/actions.draftEmailReply, which reads the client's Gmail) and,
// since Oct 27 2026, the reply box on a Messages · Email thread (app/
// emailActions.draftEmailThreadReply, which reads that thread from the comms
// log) both write through here: the same client context, the same real shoot
// dates when they ask when we can come, the same policies. DRAFT ONLY:
// nothing here sends.
// ---------------------------------------------------------------------------

export type EmailDraftResult = { ok: boolean; message: string; draft?: string };

const ASKS_WHEN = /\b(availab|when can|what (day|days|time|times)|schedul|book|come out|opening|calendar|times? work|soonest)\b/i;

export async function draftEmailFromTranscript(input: {
  clientId: string | null;
  /** who to address when there is no client record (a lead) */
  fallbackName?: string | null;
  /** oldest first */
  transcript: ConvoTurn[];
  /** the last thing they wrote, which the draft answers */
  lastText: string;
}): Promise<EmailDraftResult> {
  const client = input.clientId
    ? await prisma.client.findUnique({
        where: { id: input.clientId },
        select: {
          name: true, segment: true, socialClient: true, socialPlan: true,
          projects: { orderBy: { orderedAt: { sort: "desc", nulls: "last" } }, take: 6, select: { title: true, status: true } },
        },
      })
    : null;

  // If they're asking when we can shoot, fetch real open dates from Aryeo.
  let availability: string | null = null;
  if (ASKS_WHEN.test(input.lastText)) {
    try {
      const { getSchedulingAvailability } = await import("@/lib/integrations/aryeo");
      const { etDate } = await import("@/lib/datetime");
      const slots = await getSchedulingAvailability({ limit: 6 });
      if (slots?.length) availability = slots.map((s) => etDate(new Date(`${s.date}T12:00:00Z`))).join(", ");
    } catch {
      /* draft without availability */
    }
  }

  try {
    const { relevantPolicies } = await import("@/lib/policies");
    const policies = await relevantPolicies(input.lastText);
    const { draftReplyWithContext } = await import("@/lib/integrations/ai");
    const draft = await draftReplyWithContext({
      channel: "email",
      clientName: client?.name ?? input.fallbackName ?? null,
      segment: client?.segment ?? null,
      socialPlan: client?.socialClient ? client?.socialPlan ?? "yes" : null,
      propertyAddress: client?.projects[0]?.title ?? null,
      projects: client?.projects ?? [],
      transcript: input.transcript,
      availability,
      policies,
    });
    if (/^\s*NO_REPLY_NEEDED\s*$/i.test(draft)) return { ok: false, message: "Looks handled. No reply needed here." };
    return {
      ok: true,
      message: availability ? "Draft ready with our open shoot dates. Review before sending." : "Draft ready. Review before sending.",
      draft,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not draft a reply." };
  }
}
