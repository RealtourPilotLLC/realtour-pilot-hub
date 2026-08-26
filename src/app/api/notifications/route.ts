import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The bell's data feed.
//   GET  → the 30 newest notifications visible to the signed-in user (their
//          role's broadcasts + rows targeted at their tm:/editor: key) plus the
//          unread count vs. their watermark.
//   POST → mark seen (moves the watermark to now). Owner "view as" is strictly
//          read-only: it renders the impersonated person's bell but must never
//          move THEIR watermark.
// Role names are distinct words, so matching the audience JSON with a quoted
// substring is safe (no role is a substring of another).

function visibleWhere(u: { role: string; teamMemberId: string | null; editorKey: string | null }) {
  const userKeys = [
    u.teamMemberId ? `tm:${u.teamMemberId}` : null,
    u.editorKey ? `editor:${u.editorKey}` : null,
  ].filter((k): k is string => !!k);
  // A row ADDRESSED to this person (their tm:/editor: key) is theirs no matter
  // what audience role it was minted with — James (ADMIN login, works as a
  // photographer) had 100+ personally-addressed field rows invisible because
  // they carried audience ["PHOTOGRAPHER"] (audit Aug 25). Role gating applies
  // only to broadcasts.
  return {
    OR: [
      { audience: { contains: `"${u.role}"` }, userKey: null },
      ...(userKeys.length ? [{ userKey: { in: userKeys } }] : []),
    ],
  };
}

export async function GET() {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const where = visibleWhere(u);
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, kind: true, title: true, body: true, href: true, createdAt: true },
    }),
    prisma.notification.count({
      where: { ...where, createdAt: { gt: u.notificationsSeenAt ?? new Date(0) } },
    }),
  ]);
  return NextResponse.json({ items, unread, seenAt: u.notificationsSeenAt });
}

export async function POST() {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (u.impersonating) return new NextResponse(null, { status: 204 });
  await prisma.appUser.update({ where: { id: u.id }, data: { notificationsSeenAt: new Date() } });
  return NextResponse.json({ ok: true });
}
