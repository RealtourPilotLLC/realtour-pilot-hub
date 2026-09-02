import "server-only";
import { originOrBase } from "@/lib/appUrl";

// Google OAuth for LOGIN. Reuses the existing Google OAuth client
// (GOOGLE_CLIENT_ID/SECRET, also used for Gmail) but with a distinct redirect URI
// and minimal scopes — we only need the verified email, no offline/refresh token.

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";


export function loginConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// `origin` = the host the browser is on (hub.realtourpilot.com or the
// vercel.app host). Both are registered on the Google client; the token
// exchange must echo the exact same redirect_uri the authorize step sent.
export function loginRedirectUri(origin?: string | null): string {
  return `${originOrBase(origin)}/api/auth/callback/google`;
}

export function loginAuthorizeUrl(state: string, origin?: string | null): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", loginRedirectUri(origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

// Exchange the auth code for the user's verified email + name. The id_token comes
// directly from Google's token endpoint over our server-side TLS request (not from
// the user), so decoding its payload without re-verifying the signature is safe.
export async function exchangeLoginCode(code: string, origin?: string | null): Promise<{ email: string; name?: string } | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code.trim(),
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: loginRedirectUri(origin),
        grant_type: "authorization_code",
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id_token?: string };
    if (!json.id_token) return null;
    const part = json.id_token.split(".")[1];
    const claims = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as {
      email?: string; email_verified?: boolean | string; name?: string;
    };
    if (!claims.email || claims.email_verified === false || claims.email_verified === "false") return null;
    return { email: String(claims.email).toLowerCase(), name: claims.name };
  } catch {
    return null;
  }
}
