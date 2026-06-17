"use server";

import { prisma } from "@/lib/prisma";

export type HubAnswer = {
  answer: string;
  sources: { kind: "SOP" | "Resource"; title: string; href?: string }[];
};

// A lightweight keyword search over SOPs + resources. This is the seed of the
// "Ask the Hub" assistant — when the LLM + comms knowledge base are wired in,
// this becomes a retrieval-augmented answer instead of a keyword match.
export async function askHub(question: string): Promise<HubAnswer> {
  const q = question.trim();
  if (!q) return { answer: "Ask me anything about how we work.", sources: [] };

  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const [sops, resources] = await Promise.all([
    prisma.sop.findMany(),
    prisma.resource.findMany(),
  ]);

  const score = (text: string) =>
    terms.reduce((s, t) => s + (text.toLowerCase().includes(t) ? 1 : 0), 0);

  const sopHits = sops
    .map((s) => ({ s, score: score(`${s.title} ${s.summary ?? ""} ${s.content} ${s.category}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  const resHits = resources
    .map((r) => ({ r, score: score(`${r.title} ${r.description ?? ""} ${r.category}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (sopHits.length === 0 && resHits.length === 0) {
    return {
      answer:
        "I couldn't find a matching SOP or resource yet. As we add more procedures and connect your communication history, I'll be able to answer this from how the team actually handles it.",
      sources: [],
    };
  }

  const parts: string[] = [];
  if (sopHits.length) {
    parts.push(
      `Here's what our SOPs say:\n\n${sopHits
        .map((h) => `**${h.s.title}**\n${h.s.content}`)
        .join("\n\n")}`,
    );
  }
  if (resHits.length) {
    parts.push(
      `Related links: ${resHits.map((h) => h.r.title).join(", ")}.`,
    );
  }

  return {
    answer: parts.join("\n\n"),
    sources: [
      ...sopHits.map((h) => ({ kind: "SOP" as const, title: h.s.title })),
      ...resHits.map((h) => ({ kind: "Resource" as const, title: h.r.title, href: h.r.url })),
    ],
  };
}
