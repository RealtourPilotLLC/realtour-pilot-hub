// What the Ops Hub Slack app needs its BOT token to carry, and why. Shared by
// the Connections card (which reads the token's real scopes off auth.test) and
// the People page's "Find on Slack" button (which is what hits the missing
// one). Plain module on purpose — client components import it; nothing here
// touches a token. Sep 15: Jordan's "Slack re-auth" click was pending with no
// list of what to tick; this is that list.
export const SLACK_SCOPE_NEEDS: { scope: string; why: string; required: boolean }[] = [
  { scope: "chat:write", why: "DMs and channel posts — mentions, digests, alerts", required: true },
  { scope: "users:read", why: "look a teammate up on Slack from People", required: true },
  { scope: "users:read.email", why: "…by the email on their Team row", required: true },
  { scope: "im:write", why: "open a DM with someone the bot has never messaged (optional)", required: false },
];

// The exact fix, worded once so People and Connections say the same thing.
export const SLACK_SCOPE_FIX =
  "Re-install the Ops Hub Slack app with the users:read and users:read.email scopes (Connections → Slack), then try again.";

// Slack member IDs: U… for members, W… for Enterprise Grid users.
export const SLACK_MEMBER_ID_RE = /^[UW][A-Z0-9]{8,12}$/;
