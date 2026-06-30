"use server";

import { requireOwner } from "@/lib/auth/guards";

import { isOwnerView } from "@/lib/access";
import { summarizeHubChat, getHubChatDetail } from "@/lib/hubChats";
import { etDateTime } from "@/lib/datetime";

// Generate (or fetch cached) the detailed summary for one chat, on demand.
export async function generateChatSummary(id: string): Promise<{ ok: boolean; title?: string; summary?: string; error?: string }> {
  await requireOwner();
  if (!(await isOwnerView())) return { ok: false, error: "Not authorized." };
  try {
    const res = await summarizeHubChat(id);
    if (!res || !res.summary) return { ok: false, error: "Could not summarize this conversation." };
    return { ok: true, title: res.title, summary: res.summary };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

// Full transcript of one chat, for the expandable viewer.
export async function getChatTranscript(id: string): Promise<{ ok: boolean; messages?: { role: string; content: string; at: string }[]; error?: string }> {
  await requireOwner();
  if (!(await isOwnerView())) return { ok: false, error: "Not authorized." };
  try {
    const chat = await getHubChatDetail(id);
    if (!chat) return { ok: false, error: "Conversation not found." };
    return { ok: true, messages: chat.messages.map((m) => ({ role: m.role, content: m.content, at: etDateTime(m.createdAt) })) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}
