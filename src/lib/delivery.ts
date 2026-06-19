import "server-only";
import { parseEvidence } from "@/lib/statusEvidence";

// Public feedback form link for a project (lands in the post-delivery text).
export function feedbackUrl(projectId: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return `${base}/feedback/${projectId}`;
}

type DeliveryProject = {
  id: string;
  title: string;
  statusEvidence: string | null;
  client: { name: string };
};

// The post-delivery client text, written in Jordan's voice (no em dashes, no
// emojis, warm + low-pressure). Adapts to whether everything is delivered or
// part of it (e.g. the video) is still in production.
export function deliveryMessage(p: DeliveryProject): string {
  const first = (p.client.name || "there").trim().split(/\s+/)[0] || "there";
  const street = (p.title || "your listing").split(",")[0].trim();
  const url = feedbackUrl(p.id);
  const ev = parseEvidence(p.statusEvidence);
  const missing = ev?.missing ?? [];

  if (missing.length > 0) {
    const present = ev?.present?.length ? ev.present.join(", ").toLowerCase() : "first round of content";
    const left = missing.join(", ").toLowerCase();
    return `Hi ${first}! We just delivered the ${present} for ${street}, and the ${left} is still in production. We will have the rest over to you shortly. Let us know if you need anything. If you would like to share quick feedback on your experience, you can do that here: ${url}`;
  }
  return `Hi ${first}! We just sent everything over for ${street}. Let us know if you need anything at all. If you would like to share quick feedback on your experience, you can do that here: ${url}`;
}
