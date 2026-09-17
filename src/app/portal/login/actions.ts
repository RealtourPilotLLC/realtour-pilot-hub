"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { portalLoginEmailEnabled, requestLoginLink } from "@/lib/portalAccess";
import { CLIENT_COOKIE, clientCookieOptions } from "@/lib/auth/clientSession";

// ---------------------------------------------------------------------------
// The sign-in form and sign-out. Both are public (no session to check). The
// form NEVER reveals whether an email is known — the same sentence comes back
// for a client, a stranger and a typo, and the lookup + send happen (or,
// while the switch is off, are merely recorded) in portalAccess.
// ---------------------------------------------------------------------------

export async function requestPortalLoginLink(formData: FormData): Promise<{ ok: true; message: string }> {
  const email = String(formData.get("email") ?? "");
  // A tiny fixed delay flattens the timing difference between "known" and
  // "unknown" — cheap, and it keeps the response honest to the eye too.
  const started = Date.now();
  // `portal_login_email` is OFF until Jordan authorises launch, and while it is
  // off requestLoginLink mints nothing and enqueues nothing. Answering "a
  // sign-in link is on its way" would be a promise of an email that will never
  // arrive — on the ONLY recovery route out of a dead link (review blocker,
  // Sep 17). The state of the switch is not an account fact, so saying it
  // reveals nothing about whose email this is.
  const live = await portalLoginEmailEnabled().catch(() => false);
  // Still run it: it records the request against the person so the count of
  // people waiting on the switch is visible before launch.
  await requestLoginLink(email).catch(() => {});
  const wait = 600 - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return {
    ok: true,
    message: live
      ? "If that email has portal access, a sign-in link is on its way. It works once and expires in 15 minutes."
      : "Email sign-in isn't switched on yet. We've noted that you asked — reply to any text or email from us and we'll get you in.",
  };
}

export async function signOutPortal(): Promise<void> {
  const c = await cookies();
  c.set(CLIENT_COOKIE, "", clientCookieOptions(0));
  redirect("/portal/login?reason=signedout");
}
