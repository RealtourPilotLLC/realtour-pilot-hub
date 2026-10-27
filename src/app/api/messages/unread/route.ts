import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { editorScopeOf, isUnmappedEditor } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE MESSAGES ICON'S NUMBERS (Jordan, Oct 27 2026 Loom, 26:50 and 38:54: "a
// little icon here ... a messages button or something on the main dashboard
// for Kyle, me, and James ... same with the editors"; "we should have like a
// messages thing up here at all times and if there's any team messages it
// gets shown up there that there's an unread message").
//   clients  client conversations waiting on us that this person has not
//            opened (lib/messageReads), for the people who answer clients
//            (the communications page: Jordan, Kyle);
//   team     team chat threads with something new for them (the same count
//            the Editing Room's Messages button shows), for everyone with a
//            team center: the office's (Jordan, Kyle, James) or an editor's
//            own lane. A photographer has none.
// Read-only. Each person's answer is kept for a minute, so a tab polling
// every two minutes costs one walk at most.

type Body = { clients: number; team: number; clientsHref: string | null; teamHref: string | null };
const TTL_MS = 60_000;
const memo = new Map<string, { at: number; body: Body }>();

export async function GET() {
  const me = await getCurrentUser().catch(() => null);
  if (!me) return NextResponse.json({ clients: 0, team: 0, clientsHref: null, teamHref: null } satisfies Body, { status: 401 });
  const hit = memo.get(me.id);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body);

  const answersClients = canAccess(me, "communications");
  const editorScope = editorScopeOf(me);
  const teamScope =
    me.role === "PHOTOGRAPHER" || (me.role === "EDITOR" && (!editorScope || isUnmappedEditor(editorScope)))
      ? null
      : editorScope
        ? ({ kind: "editor", editorKey: editorScope } as const)
        : answersClients || canAccess(me, "editing")
          ? ({ kind: "office" } as const)
          : null;

  const [clients, team] = await Promise.all([
    answersClients ? clientUnread(me.id).catch(() => 0) : Promise.resolve(0),
    teamScope ? teamUnread(me.id, teamScope).catch(() => 0) : Promise.resolve(0),
  ]);
  const body: Body = {
    clients,
    team,
    clientsHref: answersClients ? "/communications" : null,
    // The office's team center is Messages' Team view; James's and an
    // editor's is the Editing Room's message center.
    teamHref: teamScope ? (answersClients ? "/communications?tab=team" : "/editing/messages") : null,
  };
  memo.set(me.id, { at: Date.now(), body });
  if (memo.size > 200) memo.delete(memo.keys().next().value as string);
  return NextResponse.json(body);
}

async function clientUnread(userKey: string): Promise<number> {
  const [{ unansweredCommsBoards }, { syntheticClientIds }, { unreadRows, waitingReadKeys }] = await Promise.all([
    import("@/lib/commsBoard"),
    import("@/lib/syntheticClients"),
    import("@/lib/messageReads"),
  ]);
  const boards = await unansweredCommsBoards(new Date(), { excludeClientIds: await syntheticClientIds() });
  const rows = [...boards.phone.map((g) => ({ family: "phone" as const, g })), ...boards.email.map((g) => ({ family: "email" as const, g }))];
  return (await unreadRows(userKey, rows, (r) => waitingReadKeys(r.family, r.g))).size;
}

async function teamUnread(userKey: string, scope: { kind: "office" } | { kind: "editor"; editorKey: string }): Promise<number> {
  const { teamChatConversations, unreadThreadCount } = await import("@/lib/editorQueue");
  const rows = await teamChatConversations(scope);
  return unreadThreadCount(userKey, rows.map((r) => r.id));
}
