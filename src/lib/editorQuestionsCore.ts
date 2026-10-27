// ---------------------------------------------------------------------------
// The pure half of "Ask a question" (lib/editorQuestions has the why and the
// send). Client-safe: the brief's buttons read who a question goes to from
// here, and the drill pins it.
// ---------------------------------------------------------------------------

export type LeftBy = { kind: "staff"; teamMemberId: string } | { kind: "client" } | { kind: "unknown" };

/** Who gets the text: the creative manager, plus the staff member who left it. Never the asker; never twice. */
export function questionRecipients(input: { creativeManagerId: string | null; leftBy: LeftBy; askerTeamMemberId?: string | null }): string[] {
  const ids = [input.creativeManagerId, input.leftBy.kind === "staff" ? input.leftBy.teamMemberId : null];
  return [...new Set(ids.filter((x): x is string => !!x && x !== input.askerTeamMemberId))];
}

/** Whose words a review note or work order is, from how the hub recorded them. */
export function leftByOfAuthorKey(authorKey: string | null | undefined, resolve: { ownerId: string | null; userTeamMember: (userId: string) => string | null; editorTeamMember: (key: string) => string | null }): LeftBy {
  const k = (authorKey ?? "").trim();
  if (!k) return { kind: "unknown" };
  if (k === "owner") return resolve.ownerId ? { kind: "staff", teamMemberId: resolve.ownerId } : { kind: "unknown" };
  if (k.startsWith("tm:")) return { kind: "staff", teamMemberId: k.slice(3) };
  if (k.startsWith("user:")) {
    const id = resolve.userTeamMember(k.slice(5));
    return id ? { kind: "staff", teamMemberId: id } : { kind: "unknown" };
  }
  if (k.startsWith("editor:")) {
    const id = resolve.editorTeamMember(k.slice(7));
    return id ? { kind: "staff", teamMemberId: id } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/** A work order's requester: our office is staff; the client, their teammate, an email or a text is the client. */
export function leftByOfBrief(kind: string | null | undefined, officeTeamMemberId: string | null): LeftBy {
  if ((kind ?? "").toUpperCase() === "OFFICE") return officeTeamMemberId ? { kind: "staff", teamMemberId: officeTeamMemberId } : { kind: "unknown" };
  return { kind: "client" };
}

/** The text, in plain words, with the link to the job's chat. */
export function questionText(i: { asker: string; street: string; about: string; words: string; link: string }): string {
  const words = i.words.replace(/\s+/g, " ").trim().slice(0, 300);
  return `${i.asker} has a question on ${i.street} (${i.about}): "${words}" Reply in the job chat: ${i.link}`;
}

export type QuestionTarget = { kind: "issue"; id: string } | { kind: "ask"; id: string } | { kind: "make" };

/** Who an editor's question on a note is texted to, in words, read the way
 *  askEditQuestion decides it: the creative manager, and the reviewer who
 *  wrote a review note; for an item of a work order, the office person who
 *  recorded it (`brief`: its requestedByKind, and requestedBy when a login is
 *  behind it), never the client. */
export function askWhoWords(
  i: { sourceKind: string; raisedByName: string | null },
  creativeManager: string,
  brief?: { kind: string | null; by: string | null } | null,
): string {
  const cm = creativeManager.trim().split(/\s+/)[0] || "the creative manager";
  const and = (name: string | null | undefined) => {
    const by = (name ?? "").trim().split(/\s+/)[0];
    return by && by.toLowerCase() !== cm.toLowerCase() ? `${cm} and ${by}` : cm;
  };
  if (i.sourceKind === "BRIEF_ITEM") return (brief?.kind ?? "").toUpperCase() === "OFFICE" ? and(brief?.by) : cm;
  return and(i.raisedByName);
}
