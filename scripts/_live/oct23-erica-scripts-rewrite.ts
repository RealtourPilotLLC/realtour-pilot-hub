export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026). Jordan: "Erica's scripts are awful. Not sure how
// that happened can you review them and fix it? They make no sense." The
// automatic fix rounds had rewritten parts in isolation until the scripts no
// longer read as one thought (Empty Nesters' hook in a client's voice, More
// Space contradicting itself, the Doorknob hook quoting a seller Erica never
// mentioned, Backyard in fragments). Rewritten by hand from her own words on
// the Oct 20 call (the writer's brief: angle, proof, must-keep points, her
// phrases), in the house format, 75–85 spoken words, no em dashes, no
// invented facts. "The 1.4 Million Yes" already reads cleanly and is left.
// Each is saved as a NEW version through the office's edit action
// (content/actions.saveScriptText, as Jordan), so every earlier version stays
// in history; a script shared or approved by the client is never touched.
// Dry run by default (prints each script and its word count); --apply saves.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const APPLY = process.argv.includes("--apply");
const ERICA = "cmt7h6b0300059kcj990r34x7";

const SCRIPTS: { title: string; body: string }[] = [
  {
    title: "More Space, or Space That Actually Works?",
    body: `More Space, or Space That Works Better?
Category: Move-Up Buyers and Sellers
HOOK
Feeling cramped doesn't always mean you need a bigger house.
Talking Point 1: Re-hook
Sometimes it does. One full bathroom and three kids is a space problem.
Talking Point 2: Build up
But my townhouse clients already have the square footage, just across three levels. They want it on two, open, so they can see the kids while they cook.
Talking Point 3: Payoff
So before you shop bigger, name what isn't working: more space, or space that works better?
Close / Call to action
Tell me what's not working, and we'll find the home that fixes it.
Optional Caption CTA
Outgrowing your home? Message me what isn't working, and we'll figure out what your next home needs to solve.`,
  },
  {
    title: "Empty Nesters Are Upsizing, Not Downsizing",
    body: `Empty Nesters Are Going Bigger on Purpose
Category: Move-Up Buyers and Sellers
HOOK
The kids moved out. So why are so many empty nesters buying bigger?
Talking Point 1: Re-hook
Where I'm working right now, it's all empty nesters, about 6,000 square feet, with giant pools for the grandkids.
Talking Point 2: Build up
It's called a magnet home: it pulls your kids and grandkids back, and makes them want to stay.
Talking Point 3: Payoff
So if you want more space, not less, don't feel like you're weird. This is the trend.
Close / Call to action
Tell me who you picture coming home, and let's plan the space for them.
Optional Caption CTA
Thinking about going bigger instead of smaller? Send me a message and tell me who you picture coming home.`,
  },
  {
    title: "I Once Watched a Deal Fall Apart Over a Doorknob",
    body: `Frustration, Not the Doorknob
Category: Personal Brand and Client Stories
HOOK
People lose houses over doorknobs.
Talking Point 1: Re-hook
Not because the doorknob matters. Because by the end, both sides are frustrated and done.
Talking Point 2: Build up
That's when I stay the calm one. I hold back my own frustration and put myself in both people's shoes. One wants to sell. One wants to buy.
Talking Point 3: Payoff
Same goal. So the question isn't who wins the doorknob. It's: how do we get there?
Close / Call to action
If something small is about to cost you the deal, call me before it does.
Optional Caption CTA
Stuck on a small issue in your deal? Send me a message and let's work out what each side really wants.`,
  },
  {
    title: "Your Backyard Vision Starts With the Lot, Not the Landscaper",
    body: `The Lot Decides the Backyard
Category: Custom-Home Buyers
HOOK
My clients pictured a pool right off the kitchen. The only lot left said no.
Talking Point 1: Re-hook
It was a walkout basement lot. So we rethought the backyard instead of giving it up.
Talking Point 2: Build up
Now it's a deck with views up top and a patio below, leading to the pool. Still going to be amazing.
Talking Point 3: Payoff
A sloped lot isn't a problem. It's a decision that shapes everything from the garage to the backyard.
Close / Call to action
Picture your backyard first, then let's make sure the lot can give it to you.
Optional Caption CTA
Building or buying a lot? Tell me the backyard you picture, and let's check the lot against it before you buy.`,
  },
];

/** The spoken words: Hook, the three talking points and the Close (not the title, category or caption). */
function spokenWords(body: string): number {
  const lines = body.split("\n");
  const spoken: string[] = [];
  let take = false;
  for (const l of lines) {
    if (/^(HOOK|Talking Point \d|Close \/ Call to action)/.test(l)) { take = true; continue; }
    if (/^(Optional Caption CTA|Category:)/.test(l)) { take = false; continue; }
    if (take && l.trim()) spoken.push(l.trim());
  }
  return spoken.join(" ").split(/\s+/).filter(Boolean).length;
}

let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };
  console.log(`=== ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  for (const s of SCRIPTS) {
    if (/—|–/.test(s.body)) throw new Error(`${s.title}: has a dash it must not have`);
    const words = spokenWords(s.body);
    const row = await prisma.contentScript.findFirst({ where: { enrollmentId: ERICA, title: s.title, historical: false }, select: { id: true, sharedAt: true, approvedAt: true, clientApprovedAt: true, currentVersionId: true } });
    if (!row) { console.log(`MISSING: ${s.title}`); continue; }
    const cur = await prisma.contentScriptVersion.findUnique({ where: { id: row.currentVersionId! }, select: { versionNo: true } });
    console.log(`\n${s.title}: now v${cur?.versionNo} · new text ${words} spoken words${row.sharedAt || row.clientApprovedAt ? " · SHARED OR CLIENT-APPROVED: left alone" : ""}`);
    if (!APPLY) { console.log(s.body); continue; }
    if (row.sharedAt || row.clientApprovedAt) continue;
    const { saveScriptText } = await import("../../src/app/content/actions");
    console.log(`  → ${JSON.stringify(await saveScriptText(row.id, s.body, { baseVersionId: row.currentVersionId }))}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
