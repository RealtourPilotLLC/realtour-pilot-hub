/** Check a communication's project link against explicit addresses in the
 * message and this client's own orders. An uncertain task stays on the client,
 * where Kyle can resolve it, instead of opening the wrong property's brief. */
export function checkedCommProject(
  message: string,
  projects: { id: string; title: string }[],
  proposedId: string | null,
): { projectId: string | null; issue: string | null } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const words = ` ${norm(message)} `;
  const named = projects.filter((p) => {
    const match = norm(p.title).match(/^(\d{1,6}) (?:[nsew] )?([a-z0-9]+)/);
    if (!match) return false;
    const [, number, street] = match;
    return words.includes(` ${number} ${street} `) || ["n", "s", "e", "w", "north", "south", "east", "west"].some((dir) => words.includes(` ${number} ${dir} ${street} `));
  });
  if (named.length > 1) return { projectId: null, issue: "The message names more than one property. Confirm the correct order before filing instructions." };
  if (proposedId && !projects.some((p) => p.id === proposedId)) return { projectId: null, issue: "The suggested order does not belong to this client. Confirm the correct order before filing instructions." };
  if (named.length === 1 && named[0].id !== proposedId) return { projectId: null, issue: "The message names a different property than the suggested order. Confirm the correct order before filing instructions." };
  return { projectId: proposedId, issue: null };
}
