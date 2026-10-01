// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Real action wrappers with pure guards/domain fakes, no database or sender.
import { createRequire } from "node:module";
import { fenceFetch, makeChecker } from "./_harness";
async function main() {
  const req = createRequire(__filename), c = makeChecker(), fence = fenceFetch();
  const stub = (file: string, exports: unknown) => { const f = req.resolve(file); req.cache[f] = { id: f, filename: f, loaded: true, exports } as NodeModule; };
  let ownerDenied = false, domainFails = false, refreshFails = false, live = true, loginFails = false;
  const calls: { kind: string; args: unknown[] }[] = [], refreshes: string[] = [], loginEmails: string[] = [];
  const domain = (kind: string, result: unknown) => async (...args: unknown[]) => { calls.push({ kind, args }); if (domainFails) throw new Error("isolated domain uncertainty"); return result; };
  stub("../../src/lib/auth/guards.ts", { requireOwner: async () => { if (ownerDenied) throw new Error("Owner access required."); } });
  stub("../../src/lib/auth/user.ts", { getCurrentUser: async () => ({ id: "fixture-office-owner" }) });
  stub("next/cache", { revalidatePath: (path: string) => { refreshes.push(path); if (refreshFails) throw new Error("isolated post-write revalidation uncertainty"); } });
  stub("next/headers", { cookies: async () => { throw new Error("session mutation not invoked"); } });
  stub("../../src/lib/portalAccess.ts", {
    isPortalRole: (r: string) => ["OWNER", "COLLABORATOR", "VIEWER"].includes(r),
    inviteClientUser: domain("invite", { note: "Domain invitation receipt." }), revokeMembership: domain("revoke", undefined), setMembershipRole: domain("role", undefined),
    rotatePortalToken: domain("rotate", { rotated: true, url: "https://example.test/fixture-share" }), expirePortalToken: domain("expire", { expiresAt: null }),
    mintLoginLink: domain("mint", { url: "https://example.test/fixture-one-time", expiresAt: new Date("2026-10-01T12:00:00Z") }),
    portalLoginEmailEnabled: async () => live,
    requestLoginLink: async (email: string) => { loginEmails.push(email); if (loginFails) throw new Error("isolated swallowed send uncertainty"); },
  });
  try {
    const a = await import("@/app/content/portalAccessActions");
    const invocations = [
      () => a.rotatePortalLink("exact-enrollment"), () => a.expirePortalLink("exact-enrollment", 0),
      () => a.invitePortalPerson("exact-enrollment", "fixture@example.test", "Exact Person", "COLLABORATOR"),
      () => a.revokePortalPerson("exact-enrollment", "exact-membership"), () => a.setPortalPersonRole("exact-enrollment", "exact-membership", "VIEWER"),
      () => a.getPortalSignInLink("exact-enrollment", "exact-membership"),
    ];
    ownerDenied = true;
    const denied = await Promise.all(invocations.map((fn) => fn()));
    c.ok("all six owner guards remain known refusals before any domain or send", denied.every((r) => !r.ok && r.outcome === "refused") && calls.length === 0 && refreshes.length === 0);
    ownerDenied = false;
    const invalidInvite = await a.invitePortalPerson("exact-enrollment", "fixture@example.test", "Exact Person", "INVALID"), invalidRole = await a.setPortalPersonRole("exact-enrollment", "exact-membership", "INVALID");
    c.ok("existing invalid-role checks remain explicit pre-write refusals", !invalidInvite.ok && invalidInvite.outcome === "refused" && !invalidRole.ok && invalidRole.outcome === "refused" && calls.length === 0);
    const confirmed = []; for (const fn of invocations) confirmed.push(await fn());
    c.ok("all completed domain/revalidation paths carry confirmed outcome without changing original messages", confirmed.every((r) => r.ok && r.outcome === "confirmed") && confirmed[2].message === "Domain invitation receipt." && confirmed[5].message.includes("15 minutes"));
    c.ok("exact enrollment, membership, email/name/role and owner attribution remain unchanged", JSON.stringify(calls) === JSON.stringify([
      { kind: "rotate", args: ["exact-enrollment"] }, { kind: "expire", args: ["exact-enrollment", 0] },
      { kind: "invite", args: ["exact-enrollment", "fixture@example.test", "Exact Person", "COLLABORATOR", "fixture-office-owner"] },
      { kind: "revoke", args: ["exact-membership", "fixture-office-owner"] }, { kind: "role", args: ["exact-membership", "VIEWER"] },
      { kind: "mint", args: ["exact-membership", "fixture-office-owner"] },
    ]) && refreshes.every((path) => path === "/content/exact-enrollment"));
    c.ok("confirmed link responses preserve exact returned credential/expiry fields", "url" in confirmed[0] && confirmed[0].url === "https://example.test/fixture-share" && "url" in confirmed[5] && confirmed[5].url === "https://example.test/fixture-one-time" && "expiresAtISO" in confirmed[5] && confirmed[5].expiresAtISO === "2026-10-01T12:00:00.000Z");
    domainFails = true; const unknown = await Promise.all(invocations.map((fn) => fn()));
    c.ok("caught domain errors are unknown rather than retry-authorizing refusals", unknown.every((r) => !r.ok && r.outcome === "unknown" && r.message === "isolated domain uncertainty"));
    domainFails = false; refreshFails = true; const late = await a.invitePortalPerson("exact-enrollment", "fixture@example.test", "Exact Person", "OWNER");
    c.ok("post-domain revalidation failure remains unknown even after the invitation domain returned", !late.ok && late.outcome === "unknown" && calls.at(-1)?.kind === "invite"); refreshFails = false;
    const { requestPortalLoginLink } = await import("@/app/portal/login/actions");
    const fd = new FormData(); fd.set("email", "opaque@example.test");
    const generic = await requestPortalLoginLink(fd); loginFails = true; const swallowed = await requestPortalLoginLink(fd);
    c.ok("public reply is identical for completed and swallowed failure, without account or send proof", generic.ok && swallowed.ok && generic.message === swallowed.message && generic.message.startsWith("Request received.") && !generic.message.includes("on its way") && generic.message.includes("cannot confirm an account or email delivery"));
    live = false; const off = await requestPortalLoginLink(fd);
    c.ok("public off-gate response preserves privacy and does not claim a recorded debt or future send", off.ok && off.message.includes("isn't switched on") && !off.message.includes("noted") && !off.message.includes("on its way") && loginEmails.length === 3);
    c.ok("wrapper-only contract fixture performs no database/provider/login/send mutation", fence.faked.length === 0 && fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
