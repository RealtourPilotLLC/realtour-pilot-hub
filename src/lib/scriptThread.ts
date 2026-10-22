import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// A SCRIPT'S OWN THREAD (Oct 22 2026). Jordan, on a client's Program
// conversation full of "About your script …" replies: "Can the replies to the
// script changes not go to the messages but under the scripts?"
//
// What a client reads under a script, oldest first, with who and when:
//   · their change requests (ScriptSuggestion), in their own words;
//   · every message about that script, from ProgramMessage:
//       refKind SCRIPT_THREAD (from Oct 22 2026): written UNDER the script, by
//         the office (the request card's reply box, or the note sent with a new
//         version) or by the client (the reply box under the script). The
//         program conversation never shows these to the client.
//       refKind SCRIPT (Oct 20 to Oct 22 2026): the office's replies that went
//         to the client's Messages carrying the script's id. They stay in
//         Messages (history is not moved) and are shown here too, read-only,
//         matched by that id and never by title.
// The office reads the same rows on the script's change-request card
// (lib/scriptRequests loadScriptRequestsForMonth).
// ---------------------------------------------------------------------------

export type ScriptThreadItem = {
  id: string;
  /** The element id on the page. The reply email's link ends with it (#reply-<message id>). */
  anchor: string;
  kind: "request" | "message";
  from: "client" | "office";
  /** A first name ("Jordan", "Janice"), never an email. */
  by: string;
  atISO: string;
  body: string;
};

/** The element id of a message under its script, and the end of the reply email's link. */
export const threadAnchor = (messageId: string) => `reply-${messageId}`;
const MAX_ITEMS = 12;

const firstName = (label: string | null | undefined, fallback: string): string => {
  const t = (label ?? "").trim();
  if (!t || t.includes("@")) return fallback;
  return t.split(/\s+/)[0] || fallback;
};

/** Each script's thread (the last twelve items, oldest first), for the client's page. */
export async function scriptThreadsFor(enrollmentId: string, scriptIds: string[]): Promise<Map<string, ScriptThreadItem[]>> {
  const out = new Map<string, ScriptThreadItem[]>();
  const ids = [...new Set(scriptIds.filter((x) => typeof x === "string" && x))];
  if (!ids.length) return out;
  const { SCRIPT_THREAD } = await import("@/lib/programMessages");
  const { replyText } = await import("@/lib/scriptRequests");
  const [requests, messages, enrollment] = await Promise.all([
    prisma.scriptSuggestion.findMany({
      where: { enrollmentId, scriptId: { in: ids } },
      orderBy: { createdAt: "asc" },
      select: { id: true, scriptId: true, body: true, createdAt: true, clientUserId: true },
    }),
    prisma.programMessage.findMany({
      where: { enrollmentId, refId: { in: ids }, OR: [{ refKind: SCRIPT_THREAD }, { refKind: "SCRIPT", authorKind: "STAFF" }] },
      orderBy: { createdAt: "asc" },
      select: { id: true, refId: true, authorKind: true, authorLabel: true, body: true, createdAt: true },
    }),
    prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } }),
  ]);
  if (!requests.length && !messages.length) return out;
  const people = [...new Set(requests.map((r) => r.clientUserId).filter((x): x is string => !!x))];
  const [names, client] = await Promise.all([
    people.length ? prisma.clientUser.findMany({ where: { id: { in: people } }, select: { id: true, name: true } }) : Promise.resolve([]),
    enrollment ? prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } }) : Promise.resolve(null),
  ]);
  const account = firstName(client?.name, "You");
  const nameOf = new Map(names.map((p) => [p.id, firstName(p.name, account)]));
  for (const id of ids) {
    const items: ScriptThreadItem[] = [
      ...requests.filter((r) => r.scriptId === id).map((r) => ({
        id: r.id, anchor: `request-${r.id}`, kind: "request" as const, from: "client" as const,
        by: (r.clientUserId && nameOf.get(r.clientUserId)) || account, atISO: r.createdAt.toISOString(), body: r.body,
      })),
      ...messages.filter((m) => m.refId === id).map((m) => {
        const office = m.authorKind === "STAFF";
        return {
          id: m.id, anchor: threadAnchor(m.id), kind: "message" as const, from: office ? ("office" as const) : ("client" as const),
          // A staff label through the owner iframe reads "Kyle (on behalf of …)": the first word is the person.
          by: office ? firstName(m.authorLabel, "Realtour Pilot") : firstName(m.authorLabel, account),
          atISO: m.createdAt.toISOString(),
          // The old Messages copies began "About your script "…":"; under the script that is said already.
          body: office ? replyText(m.body) : m.body,
        };
      }),
    ];
    if (!items.length) continue;
    // ISO times sort as text; a request and a reply in the same instant keep the request first.
    items.sort((a, b) => a.atISO.localeCompare(b.atISO) || Number(b.kind === "request") - Number(a.kind === "request"));
    out.set(id, items.slice(-MAX_ITEMS));
  }
  return out;
}
