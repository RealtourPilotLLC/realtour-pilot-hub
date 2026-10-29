import "server-only";
import type { CurrentUser } from "@/lib/auth/user";
import { canSeeMoney } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";
import { etAddDays, etDayStartUtc } from "@/lib/datetime";
import { parseStoredLinks, type HubLinkView } from "@/lib/hubLinks";
import { hubLinkViews } from "@/lib/hubLinkAccess";
import { messageFileViews, type MessageFileView } from "@/lib/messageAttachments";

// ---------------------------------------------------------------------------
// WHAT A TEAM MESSAGE CARRIES BESIDE ITS WORDS (Oct 28 2026), for every board
// that draws one: the job page, the editor brief, the shoot screen, the
// message center and the team channel. Files (as this viewer may see their
// names), hub links (each checked for THIS viewer: a page they can't open
// keeps its title and loses its link), and whether the message is old enough
// to fold.
//
// OLDER THAN 10 DAYS FOLDS (Jordan, Oct 28 2026: "any communications older
// than 10 days should be collapsed. Like georgiana, she has so many messages
// in her job page you have to scroll a lot to get to the bottom of the
// page"). Decided here, on the server, by the Eastern calendar: a message from
// before the ET day ten days ago folds. The board never reads the clock.
// ---------------------------------------------------------------------------

export const MESSAGE_FOLD_DAYS = 10;

/** Messages created before this instant fold: ET midnight, ten ET days ago. */
export function messageFoldCutoff(now: Date = new Date()): Date {
  return etDayStartUtc(etAddDays(now, -MESSAGE_FOLD_DAYS));
}

export type MessageExtra = { files: MessageFileView[]; links: HubLinkView[]; old: boolean };

/** Files, links and the fold flag for these rows, as `viewer` sees them. */
export async function messageExtras(
  rows: { id: string; links?: string | null; createdAt: Date }[],
  viewer: CurrentUser | null,
  opts: { channel?: boolean; now?: Date } = {},
): Promise<(id: string) => MessageExtra> {
  const ids = rows.map((r) => r.id);
  const money = viewer ? canSeeMoney(viewer.role) : !authEnforced();
  const files = await messageFileViews(opts.channel ? { channelMessageIds: ids } : { projectMessageIds: ids }, { money }).catch(
    () => new Map<string, MessageFileView[]>(),
  );
  const cache = new Map<string, boolean>();
  const links = new Map<string, HubLinkView[]>();
  for (const r of rows) {
    const refs = parseStoredLinks(r.links);
    if (refs.length) links.set(r.id, await hubLinkViews(refs, viewer, cache).catch(() => refs.map((x) => ({ title: x.title, href: null, kind: x.kind }))));
  }
  const cutoff = messageFoldCutoff(opts.now);
  const created = new Map(rows.map((r) => [r.id, r.createdAt]));
  return (id: string) => ({
    files: files.get(id) ?? [],
    links: links.get(id) ?? [],
    old: (created.get(id)?.getTime() ?? Infinity) < cutoff.getTime(),
  });
}
