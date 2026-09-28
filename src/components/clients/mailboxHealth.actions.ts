"use server";

import { requireAdmin } from "@/lib/auth/guards";

// The one-line footnote a related-message view carries when an inbox is not
// being read (§9, Sep 26 2026: "a related-message view is not a guarantee all
// inboxes are synced"). Read off what the five-minute scan recorded — never a
// Google call — so it costs one small query when the panel opens.
export async function loadMailboxGap(): Promise<string | null> {
  await requireAdmin();
  try {
    const { mailboxReadHealth, mailboxGapSentence } = await import("@/lib/gmailHealth");
    return mailboxGapSentence(await mailboxReadHealth());
  } catch {
    return null; // the footnote is a courtesy; its absence must not break the panel
  }
}
