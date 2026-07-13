import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { isTrackablePath } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Page-view beacon for the owner-only usage trail (People → Activity). The
// Shell posts the pathname on every in-app navigation; WHO is taken from the
// verified session — nothing identity-shaped is trusted from the body. Silent
// no-op (204) whenever there's nothing legitimate to record.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser().catch(() => null);
  // No session (or a disabled account's stale token) → nothing to attribute.
  // "View as" previews are the OWNER browsing — recording them under the
  // previewed person would fake their activity, so they're skipped entirely.
  if (!user || user.impersonating) return new NextResponse(null, { status: 204 });

  let path = "";
  try {
    const body = (await req.json()) as { path?: unknown };
    if (typeof body.path === "string") path = body.path;
  } catch { /* malformed body → ignore */ }
  path = path.slice(0, 200);
  // Only record OUR route shapes — an arbitrary client string would let a user
  // paint fabricated entries into the owner's trail (and grow the table).
  if (!path.startsWith("/") || path.startsWith("/login") || path.startsWith("/invite") || !isTrackablePath(path)) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    // Flood cap: a human doesn't navigate 120+ times an hour; a script might.
    const lastHour = await prisma.usageEvent.count({
      where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 3600_000) } },
    });
    if (lastHour >= 120) return new NextResponse(null, { status: 204 });

    // Atomic dedupe: the row id IS user+path+20s-bucket, so double-fires
    // (React strict mode, two tabs racing) collapse on the unique id instead
    // of racing past a check-then-create.
    const bucket = Math.floor(Date.now() / 20_000);
    const id = crypto.createHash("sha1").update(`${user.id}|${path}|${bucket}`).digest("hex").slice(0, 25);
    await prisma.usageEvent
      .create({
        data: {
          id,
          userId: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          path,
        },
      })
      .catch(() => null); // unique-id collision = the dedupe doing its job
  } catch { /* tracking must never break the app */ }

  return new NextResponse(null, { status: 204 });
}
