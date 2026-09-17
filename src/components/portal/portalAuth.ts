import type { PortalAuth } from "@/app/portal/actions";

// How a portal component identifies its visit when it calls a server action:
// from the ADDRESS BAR, at call time. The token is deliberately not passed
// down as a prop — a prop is serialised into the page's RSC payload, and the
// whole point of the Sep 16 identity work is that the page HTML never carries
// the enrollment token (it used to sit in every <video src>).
//   /portal/<token>         → { token }
//   /portal/me?e=<id>       → { enrollmentId } (the cookie does the rest)
//   /portal/me              → {} (the person's only / first program)
export function portalAuthFromLocation(): PortalAuth {
  if (typeof window === "undefined") return {};
  const m = /^\/portal\/([^/?#]+)/.exec(window.location.pathname);
  const seg = m ? decodeURIComponent(m[1]) : "";
  if (seg && seg !== "me") return { token: seg };
  const e = new URLSearchParams(window.location.search).get("e");
  return e ? { enrollmentId: e } : {};
}
