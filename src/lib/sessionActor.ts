import "server-only";
import { getCurrentUser } from "@/lib/auth/user";
import { displayNameFor } from "@/lib/actorName";

/**
 * The person pressing the button this code runs under, by display name (roster
 * before email — lib/actorName) and login id. Null outside a request (a cron,
 * a script) and for a "view as" preview, which writes nothing in anyone's
 * name. Its own module so a library that must stay loadable outside Next
 * (lib/tasks) can reach the session through one dynamic import (Sep 28).
 */
export async function signedInActor(): Promise<{ name: string; userId: string | null } | null> {
  try {
    const me = await getCurrentUser();
    if (!me || me.impersonating) return null;
    const name = await displayNameFor(me);
    return name ? { name, userId: me.id } : null;
  } catch {
    return null; // no request scope
  }
}
