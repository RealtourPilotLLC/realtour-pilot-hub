"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requestLoginLink } from "@/lib/portalAccess";
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
  await requestLoginLink(email).catch(() => {});
  const wait = 600 - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return { ok: true, message: "If that email has portal access, a sign-in link is on its way. It works once and expires in 15 minutes." };
}

export async function signOutPortal(): Promise<void> {
  const c = await cookies();
  c.set(CLIENT_COOKIE, "", clientCookieOptions(0));
  redirect("/portal/login?reason=signedout");
}
