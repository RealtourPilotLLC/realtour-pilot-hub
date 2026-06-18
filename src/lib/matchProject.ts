import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Best-effort: figure out which project a free-text message (Slack, email, …)
// is about, by looking for its street address or client name in the text.
// Returns the strongest match, or null when nothing is confidently referenced.
// ---------------------------------------------------------------------------

export type ProjectMatch = {
  id: string;
  title: string;
  clientId: string;
  clientName: string;
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export async function matchProjectFromText(text: string): Promise<ProjectMatch | null> {
  const t = norm(text);
  if (t.length < 3) return null;

  // Prefer recent, non-cancelled jobs; cap the scan for performance.
  const projects = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    take: 600,
    select: {
      id: true,
      title: true,
      addressLine: true,
      clientId: true,
      client: { select: { name: true } },
    },
  });

  let best: ProjectMatch | null = null;
  let bestScore = 0;

  for (const p of projects) {
    let score = 0;
    const street = norm(p.addressLine || p.title.split(",")[0] || "");
    if (street) {
      const tokens = street.split(" ");
      const num = tokens[0];
      const name1 = tokens[1];
      // "320 tarbert" — street number + first street word is a strong signal.
      if (num && /^\d+$/.test(num) && name1 && t.includes(`${num} ${name1}`)) score += 3;
      else if (street.length >= 7 && t.includes(street)) score += 3;
    }
    const cname = norm(p.client?.name ?? "");
    if (cname) {
      if (cname.length > 4 && t.includes(cname)) score += 2;
      else {
        // last name (>=4 chars) as a weaker hint
        const last = cname.split(" ").filter((w) => w.length >= 4).pop();
        if (last && new RegExp(`\\b${last}\\b`).test(t)) score += 1;
      }
    }
    // Most-recent wins ties (projects are already newest-first).
    if (score > bestScore) {
      bestScore = score;
      best = { id: p.id, title: p.title, clientId: p.clientId, clientName: p.client?.name ?? "" };
    }
  }

  // Require a real reference (a street hit, or a full client-name hit).
  return bestScore >= 2 ? best : null;
}
