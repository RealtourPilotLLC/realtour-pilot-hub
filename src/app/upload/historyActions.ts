"use server";

import { listUploadHistory, type HistoryPage, type UploadViewerScope } from "@/lib/uploadHistory";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { authEnforced } from "@/lib/auth/guards";
import { photographerMemberId } from "@/lib/shoot";

// Search / paging for the "Past uploads" section on /upload (Jordan, Sep 15).
// The viewer's scope is resolved HERE, never trusted from the client: a
// photographer's call is pinned to their own shoots whatever it asks for, and
// only the office's photographer filter is honoured.

/** Who is calling, and at whose shoots — the same pin the /upload page
 *  resolves for its buckets. Throws when auth is enforced and the caller may
 *  not open the Upload Portal at all, so a stale session can't page through
 *  other people's jobs. (Not exported: a "use server" export is an action.) */
async function viewerScope(): Promise<UploadViewerScope> {
  const user = await getCurrentUser().catch(() => null);
  if (authEnforced()) {
    if (!user) throw new Error("Please sign in to do that.");
    if (!canAccess(user, "upload")) throw new Error("You don't have access to the Upload Portal.");
  }
  if (user?.role === "PHOTOGRAPHER") {
    return { mine: (await photographerMemberId(user)) ?? "__none__", office: false };
  }
  return { mine: null, office: true };
}

export async function searchUploadHistory(input: {
  q?: string;
  photographerId?: string | null;
  offset?: number;
}): Promise<HistoryPage> {
  const scope = await viewerScope();
  return listUploadHistory(scope, {
    q: typeof input.q === "string" ? input.q : "",
    photographerId: scope.office && typeof input.photographerId === "string" ? input.photographerId : null,
    offset: typeof input.offset === "number" && Number.isFinite(input.offset) ? input.offset : 0,
  });
}
