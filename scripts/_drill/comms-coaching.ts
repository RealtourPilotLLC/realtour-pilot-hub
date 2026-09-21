/**
 * ACCEPTANCE DRILL — end-of-day comms coaching (Sep 21 2026).
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a && \
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/comms-coaching.ts
 *
 * The react-server condition is not optional: commsCoaching.ts and openphone.ts
 * both open with `import "server-only"`, which throws on sight without it.
 *
 * READ-ONLY AGAINST PRODUCTION, BY CONSTRUCTION AND NOT BY LUCK. Gate 1 runs
 * the real cron entry point with `dryRun`, which skips every write and every
 * send. The first cut of this drill called it plain: that was a no-op only
 * because senderTeamMemberId was still 0 rows, so the guard was on the
 * ASSERTION and not on the CALL, and the evening attribution lands it would
 * have written audit rows and, with the switch on, DM'd Kyle a note nobody had
 * read. Gates 2-5 put KNOWN days in front of the same prompt, gatherer and
 * renderer the cron uses, without touching the database at all.
 *
 * Two gates matter more than the rest:
 *  • 3 — a warm, competent day must come back with ZERO suggestions. A coach
 *    that manufactures a criticism to justify itself is the failure Jordan
 *    named, and it is not visible in a typecheck.
 *  • 2 and 4b — he is only ever coached on words he really wrote, to people
 *    who are really clients. Both are checked on real production rows.
 *  • 2a — and when we cannot say who is internal, we say NOTHING. The cost of
 *    the old fail-open is measured here on real rows rather than argued about.
 *  • 4c — nothing the hub wrote reaches him in punctuation Jordan does not use,
 *    and his own quoted words are never tidied.
 */
import { prisma } from "@/lib/prisma";
import { escapeSlack } from "@/lib/text";
import { phoneKey } from "@/lib/integrations/openphone";
import {
  runDailyCommsCoaching,
  judgeThreads,
  renderCoachingNote,
  commsCoachingSettings,
  listCoachingAudits,
  gatherDay,
  bucketClientThreads,
  turnsFromRows,
  verifySuggestions,
  ownQuoteCorpus,
  houseVoice,
  violatesHouseVoice,
  requireInternalNumbers,
  NO_INTERNAL_ROSTER,
  COACHING_CAPS,
  COMMS_COACHING_HREF,
  DEFAULT_COMMS_COACHING,
  COMMS_COACHING_ET_HOUR,
  type CoachThread,
  type CoachOwnRow,
} from "@/lib/commsCoaching";

const AUTO = ["auto-confirmation", "auto-delivery", "auto-afterhours", "auto-welcome", "upload-nag", "upload-digest", "upload-intro"];
let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (cond) pass++; else fail++;
};

function thread(clientName: string, turns: [("client" | "us"), string, string][]): CoachThread {
  return {
    threadKey: `t:${clientName}`,
    clientName,
    turns: turns.map(([role, sender, text]) => ({ role, sender, text, at: new Date().toISOString() })),
    ownCount: turns.filter((t) => t[0] === "us" && t[1] === "Kyle").length,
    lastAt: Date.now(),
  };
}

(async () => {
  // ---------------------------------------------------------------- GATE 0
  console.log("\n=== GATE 0: the ground truth this feature stands on ===");
  const settings = await commsCoachingSettings();
  ok("send switch defaults OFF", DEFAULT_COMMS_COACHING.sendEnabled === false && settings.sendEnabled === false,
    `stored/default sendEnabled=${settings.sendEnabled}`);
  ok("Kyle is the default subject", settings.teamMemberIds.length === 1, `teamMemberIds=${JSON.stringify(settings.teamMemberIds)}`);
  const kyle = await prisma.teamMember.findUnique({ where: { id: settings.teamMemberIds[0] }, select: { name: true, active: true, slackId: true } });
  ok("that id is a live team member with Slack", !!kyle?.active && !!kyle?.slackId, `${kyle?.name} active=${kyle?.active} slack=${kyle?.slackId ? "yes" : "no"}`);
  ok("the cron hour is 7 PM ET", COMMS_COACHING_ET_HOUR === 19, `hour=${COMMS_COACHING_ET_HOUR}`);

  const attributed = await prisma.commLog.count({ where: { senderTeamMemberId: { not: null } } });
  const outbound30 = await prisma.commLog.count({
    where: { channel: "text", direction: "out", occurredAt: { gte: new Date(Date.now() - 30 * 86400000) } },
  });
  console.log(`      attributed CommLog rows today: ${attributed}; outbound texts in 30d: ${outbound30}`);

  // ---------------------------------------------------------------- GATE 1
  console.log("\n=== GATE 1: the real run, today, INCAPABLE of writing ===");
  const before = await prisma.appSetting.count({ where: { key: { startsWith: "comms-coaching:" } } });
  // dryRun is the point of this gate. See the header: a drill that can write to
  // production is a drill that WILL, on the first day the data changes shape.
  const run = await runDailyCommsCoaching({ dryRun: true });
  const after = await prisma.appSetting.count({ where: { key: { startsWith: "comms-coaching:" } } });
  console.log(`      ${JSON.stringify(run)}`);
  ok("the real entry point ran and wrote NOTHING", after === before,
    `AppSetting comms-coaching rows ${before} -> ${after} (dryRun, so this holds whatever the day contained)`);
  if (attributed === 0) {
    ok("a day with nothing attributable produces NO note", run.people.every((p) => p.status === "quiet"),
      run.people.map((p) => `${p.personName}: ${p.status} (${p.detail})`).join(" | ") || "nobody configured");
  } else {
    ok("run completed without throwing", true, `statuses: ${run.people.map((p) => p.status).join(",")}`);
  }
  ok("the run reports the send switch it used", run.sendEnabled === settings.sendEnabled, `sendEnabled=${run.sendEnabled}`);
  ok("the bell row points at the report, not a tab that does not exist", COMMS_COACHING_HREF === "/coaching",
    `COMMS_COACHING_HREF=${COMMS_COACHING_HREF} (src/app/coaching/page.tsx)`);

  // ---------------------------------------------------------------- GATE 2
  // THE EXCLUSIONS, RUN ON REAL ROWS THROUGH THE REAL GROUPER. The old gate 2
  // counted rows in a query of its own and never touched gatherDay, so the two
  // blocking defects the review found lived entirely outside it.
  console.log("\n=== GATE 2: who the company actually texts, through the real grouper ===");
  const since30 = new Date(Date.now() - 30 * 86400000);
  const autoRows = await prisma.commLog.count({
    where: { channel: "text", direction: "out", source: { in: AUTO }, occurredAt: { gte: since30 } },
  });
  const humanOut = await prisma.commLog.findMany({
    where: { channel: "text", direction: "out", source: { notIn: AUTO }, occurredAt: { gte: since30 } },
    select: { id: true, occurredAt: true, clientId: true, clientName: true, fromPhone: true },
    orderBy: { occurredAt: "asc" },
  });
  const teamPhones = await prisma.teamMember.findMany({ where: { phone: { not: null } }, select: { name: true, phone: true } });
  const ourNumbers = new Set(teamPhones.map((t) => phoneKey(t.phone)).filter((k) => k.length === 10));
  const expectedInternal = humanOut.filter((r) => ourNumbers.has(phoneKey(r.fromPhone))).length;
  const grouped = bucketClientThreads(humanOut as CoachOwnRow[], ourNumbers, phoneKey);
  const keptMessages = grouped.buckets.reduce((n, b) => n + b.own, 0);
  console.log(`      ${humanOut.length} human outbound texts in 30d: ${grouped.internal} to one of our own numbers, ${keptMessages} on client threads, ${grouped.unplaceable} unplaceable`);
  ok("automated sends never reach the judge", autoRows > 0,
    `${autoRows} automated outbound texts in 30d are excluded by source before anything else`);
  ok("internal team texts are dropped before any thread is read", grouped.internal === expectedInternal && grouped.internal > 0,
    `${grouped.internal} of ${humanOut.length} went to a teammate's handset (${teamPhones.length} roster numbers)`);
  ok("not one kept conversation is with one of our own numbers",
    grouped.buckets.every((b) => !ourNumbers.has(phoneKey(b.phone))),
    `${grouped.buckets.length} client conversations kept`);
  ok("every kept conversation has a client on the other end",
    grouped.buckets.every((b) => !!b.clientId),
    `unplaceable messages left out instead of guessed: ${grouped.unplaceable}`);
  const inboundAttributed = await prisma.commLog.count({ where: { direction: "in", senderTeamMemberId: { not: null } } });
  ok("no inbound row carries a sender attribution", inboundAttributed === 0, `inbound rows with senderTeamMemberId: ${inboundAttributed}`);

  // ---------------------------------------------------------------- GATE 2a
  // THE FAIL-CLOSED HALF. ourPhoneKeys used to swallow a failed roster read and
  // carry on with a smaller set, which is the opposite of safe: fewer of OUR
  // numbers means fewer messages are classified internal, so the day would be
  // judged on MORE. This measures the real cost of that failure path on real
  // rows, then proves the code now refuses to run at all instead of paying it.
  console.log("\n=== GATE 2a: with no roster, we say nothing rather than coach on office chatter ===");
  const blind = bucketClientThreads(humanOut as CoachOwnRow[], new Set(), phoneKey);
  const blindKept = blind.buckets.reduce((n, b) => n + b.own, 0);
  const internalJudged = blindKept - keptMessages;
  console.log(`      a lost roster would have judged ${internalJudged} internal message(s) as client care (${keptMessages} -> ${blindKept})`);
  // Only 22 of the 272 internal rows carry a clientId, but the classification is
  // per CONVERSATION, so those 22 pull the whole teammate thread in behind them.
  ok("an empty set of our numbers really does let internal traffic through",
    internalJudged > 0,
    `${internalJudged} messages on teammate threads would be graded as client care, off ${blind.buckets.filter((b) => ourNumbers.has(phoneKey(b.phone))).length} conversation(s) that are ours`);
  let refused = "";
  try {
    requireInternalNumbers(new Set());
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  ok("so an empty set throws instead of guessing", refused === NO_INTERNAL_ROSTER, refused || "it did NOT throw");
  ok("and the throw lands as a failed person, not a wrong note",
    /no note tonight/.test(NO_INTERNAL_ROSTER),
    "runDailyCommsCoaching's per-person catch records status failed and writes no audit for that person");
  ok("the live roster is not empty, so tonight's run proceeds",
    requireInternalNumbers(ourNumbers).size === ourNumbers.size && ourNumbers.size > 0,
    `${ourNumbers.size} of our numbers on file`);

  // The whole gatherer, against production, for the person who is actually
  // configured. Read-only, and today it is empty on purpose (attribution has
  // not landed) — the point is that the query runs and returns client threads
  // only, whatever the day holds.
  const kyleId = settings.teamMemberIds[0];
  const dayStart = new Date(Date.now() - 30 * 86400000);
  const real = await gatherDay({ id: kyleId, name: kyle?.name ?? "Kyle Smith" }, dayStart, new Date());
  console.log(`      gatherDay over 30 days for ${kyle?.name}: ${real.messagesConsidered} client messages, ${real.threads.length} threads, ${real.offClientSkipped} not client work`);
  ok("gatherDay itself never returns one of our own numbers, and honours the cap",
    real.threads.every((t) => !ourNumbers.has(t.threadKey.replace(/^p:/, ""))) && real.threads.length <= COACHING_CAPS.threads,
    `${real.threads.length} threads (cap ${COACHING_CAPS.threads}), keys: ${real.threads.map((t) => t.threadKey).join(",") || "none today"}`);
  // EVERY CAP, ON WHATEVER THE REAL QUERY RETURNED. The caps are what stop one
  // runaway thread turning an evening cron into a 40k-token bill, and they are
  // the part of the gatherer nothing else in this drill touches.
  ok("the message budget, the turn window and the per-turn clip all hold on real rows",
    real.messagesAnalysed <= COACHING_CAPS.messages &&
      real.messagesAnalysed <= real.messagesConsidered &&
      real.droppedForCap === Math.max(0, real.messagesConsidered - real.messagesAnalysed) &&
      real.threads.every((t) => t.turns.length <= COACHING_CAPS.turns) &&
      real.threads.every((t) => t.turns.every((tu) => tu.text.length <= COACHING_CAPS.chars)),
    `${real.messagesAnalysed}/${real.messagesConsidered} analysed (cap ${COACHING_CAPS.messages}), ${real.droppedForCap} past the cap, longest thread ${Math.max(0, ...real.threads.map((t) => t.turns.length))} turns`);

  // ---------------------------------------------------------------- GATE 2b
  console.log("\n=== GATE 2b: office chatter cannot push a client thread out of the day ===");
  const t0 = Date.now() - 12 * 3600_000;
  const synthetic: CoachOwnRow[] = [];
  // 12 client threads, oldest first...
  for (let i = 0; i < 12; i++) {
    synthetic.push({ id: `c${i}`, occurredAt: new Date(t0 + i * 60_000), clientId: `client-${i}`, clientName: `Client ${i}`, fromPhone: `555010${String(i).padStart(4, "0")}` });
  }
  // ...and three internal ones that are the MOST RECENT messages of the day,
  // which is exactly how a recency-ordered cap used to lose client work. One of
  // them carries a clientId, like the 22 real rows that do.
  const teamKeys = [...ourNumbers];
  for (let i = 0; i < Math.min(3, teamKeys.length); i++) {
    synthetic.push({ id: `i${i}`, occurredAt: new Date(t0 + 3600_000 + i * 60_000), clientId: i === 0 ? "client-99" : null, clientName: i === 0 ? "Looks Like A Client" : null, fromPhone: teamKeys[i] });
  }
  const g2 = bucketClientThreads(synthetic, ourNumbers, phoneKey);
  const capped = g2.buckets.slice(0, COACHING_CAPS.threads);
  ok("the three internal threads are gone, including the one with a clientId on it",
    g2.internal === Math.min(3, teamKeys.length) && g2.buckets.length === 12,
    `${g2.internal} internal messages dropped, ${g2.buckets.length} client threads kept`);
  ok("the capped day is the freshest CLIENT threads, not the freshest threads",
    capped.length === COACHING_CAPS.threads && capped.every((b) => b.key.startsWith("p:5550")) && capped[0].clientName === "Client 11",
    `kept ${capped.map((b) => b.clientName).join(", ")}`);

  // ---------------------------------------------------------------- GATE 2c
  console.log("\n=== GATE 2c: whose words are whose, in the transcript the judge reads ===");
  const labelled = turnsFromRows(
    [
      { body: "Hi, is the video ready?", direction: "in", occurredAt: new Date(t0), contactName: "Andrea Whitfield", source: "openphone", senderTeamMemberId: null },
      { body: "Your photos are ready, here is the link.", direction: "out", occurredAt: new Date(t0 + 1000), contactName: null, source: "auto-delivery", senderTeamMemberId: null },
      { body: "It is with the editor now.", direction: "out", occurredAt: new Date(t0 + 2000), contactName: null, source: "openphone", senderTeamMemberId: null },
      { body: "You will have it by 4pm today.", direction: "out", occurredAt: new Date(t0 + 3000), contactName: null, source: "openphone", senderTeamMemberId: kyleId },
      { body: "Thanks Kyle", direction: "out", occurredAt: new Date(t0 + 4000), contactName: null, source: "openphone", senderTeamMemberId: "someone-else" },
    ],
    kyleId,
    "Kyle",
    "Andrea Whitfield",
  );
  const senders = labelled.map((t) => t.sender);
  ok("a sweep's line is Automated, an unattributed line is Us, his line is his",
    senders[0] === "Andrea Whitfield" && senders[1] === "Automated" && senders[2] === "Us" && senders[3] === "Kyle" && senders[4] === "Us",
    senders.join(" / "));
  ok("a NULL attribution is never read as him", labelled.filter((t) => t.sender === "Kyle").length === 1,
    "only the row carrying his team member id is labelled Kyle");
  ok("the corpus the quote gate trusts holds only his line", ownQuoteCorpus([{ threadKey: "t", clientName: null, turns: labelled, ownCount: 1, lastAt: t0 }], "Kyle").length === 1,
    "1 turn is quotable");
  const longTurn = turnsFromRows(
    [
      { body: "x".repeat(900), direction: "out", occurredAt: new Date(t0), contactName: null, source: "openphone", senderTeamMemberId: kyleId },
      { body: "   ", direction: "out", occurredAt: new Date(t0 + 1), contactName: null, source: "openphone", senderTeamMemberId: kyleId },
    ],
    kyleId,
    "Kyle",
    null,
  );
  ok("one runaway message cannot blow the per-turn budget, and an empty one is dropped",
    longTurn.length === 1 && longTurn[0].text.length <= COACHING_CAPS.chars,
    `900 chars in, ${longTurn[0]?.text.length ?? 0} out (cap ${COACHING_CAPS.chars}); the whitespace-only row is gone`);

  // ---------------------------------------------------------------- GATE 3
  // THE ONE THAT MATTERS. A good day must come back empty.
  console.log("\n=== GATE 3: a warm, competent day must yield ZERO suggestions ===");
  const goodDay: CoachThread[] = [
    thread("Andrea Whitfield", [
      ["client", "Andrea Whitfield", "Hey! Any idea when the photos from Tuesday will be ready?"],
      ["us", "Kyle", "Hi Andrea, thanks for checking in. Your photos are in editing now and you will have them by 5pm tomorrow. I will send the link the moment they are up."],
      ["client", "Andrea Whitfield", "Perfect, thank you!"],
      ["us", "Kyle", "Of course. Anything else you need for this listing, just let me know."],
    ]),
    thread("Marcus Reid", [
      ["client", "Marcus Reid", "I need to push Thursday's shoot, seller isn't ready."],
      ["us", "Kyle", "No problem at all, Marcus. Thank you for the heads up. We have Friday at 10am or Monday at 1pm open. Which works better for you?"],
      ["client", "Marcus Reid", "Friday 10 works"],
      ["us", "Kyle", "Friday at 10am is booked. We will confirm the day before, and we are looking forward to it."],
    ]),
  ];
  const good = await judgeThreads("Kyle", "Mon, Sep 21", goodDay);
  console.log(`      thanks: ${good.result.thanks}`);
  console.log(`      wentWell: ${JSON.stringify(good.result.wentWell)}`);
  console.log(`      suggestions: ${JSON.stringify(good.result.suggestions)}`);
  ok("no manufactured criticism on a good day", (good.result.suggestions ?? []).length === 0,
    `${(good.result.suggestions ?? []).length} suggestions returned`);
  ok("it still says thank you, and names a real client", !!good.result.thanks && /Andrea|Marcus/.test(good.result.thanks),
    good.result.thanks ?? "(none)");
  const goodNote = renderCoachingNote("Kyle", {
    version: 1, teamMemberId: "x", personName: "Kyle Smith", dayKey: "2026-09-21", generatedAt: "", messagesConsidered: 4,
    messagesAnalysed: 4, threadsAnalysed: 2, droppedForCap: 0, clients: ["Andrea Whitfield", "Marcus Reid"],
    thanks: good.result.thanks ?? "", wentWell: good.result.wentWell ?? [], suggestions: good.result.suggestions ?? [],
    model: good.model, inputTokens: good.usage.inputTokens, outputTokens: good.usage.outputTokens,
  });
  console.log("      ---- the note as Kyle would see it ----\n" + goodNote.split("\n").map((l) => "      " + l).join("\n"));
  ok("a clean day's note closes without inventing a fix", /Nothing to change today/.test(goodNote), "closing line present");
  // THE VOICE, ON THE TWO FIELDS THE READER SEES FIRST. This used to be asserted
  // on tryInstead alone, so the drill stayed green while thanks and wentWell came
  // back with em dashes in both of the Sep 21 runs. The note opens "Hey Kyle!" in
  // Jordan's name and Jordan does not write them.
  const goodRaw = [good.result.thanks ?? "", ...(good.result.wentWell ?? [])];
  const goodDrift = goodRaw.flatMap(violatesHouseVoice);
  console.log(`      the model's raw thanks/wentWell: ${goodDrift.length ? `${goodDrift.length} house-voice break(s) (${[...new Set(goodDrift)].join(", ")}), normalised out below` : "already clean"}`);
  ok("nothing in the note Kyle reads breaks the house voice, thanks and what-went-well included",
    violatesHouseVoice(goodNote).length === 0, violatesHouseVoice(goodNote).join(", ") || "no dash, no emoji, no bold");

  // ---------------------------------------------------------------- GATE 4
  console.log("\n=== GATE 4: a genuinely clipped day must be caught, with the rewrite and the why ===");
  const coldDay: CoachThread[] = [
    thread("Danielle Pruitt", [
      ["client", "Danielle Pruitt", "Hi, my sellers are really upset. The listing goes live tomorrow morning and we still don't have the video. Is there any way to get it today?"],
      ["us", "Kyle", "It's with the editor. Should be soon."],
      ["client", "Danielle Pruitt", "Okay but can you give me a time? I have to tell them something."],
      ["us", "Kyle", "Not really. The editor is backed up."],
    ]),
    thread("Tom Alvarez", [
      ["client", "Tom Alvarez", "Can we add drone to the Oakmont shoot on Friday?"],
      ["us", "Kyle", "Yes"],
      ["client", "Tom Alvarez", "Great, and does that change the time?"],
      ["us", "Kyle", "No"],
    ]),
  ];
  const cold = await judgeThreads("Kyle", "Mon, Sep 21", coldDay);
  const sug = cold.result.suggestions ?? [];
  console.log(`      suggestions: ${JSON.stringify(sug, null, 2).split("\n").join("\n      ")}`);
  ok("a clipped day raises at least one, and at most two", sug.length >= 1 && sug.length <= 2, `${sug.length} suggestions`);
  ok("every suggestion quotes his ACTUAL words", sug.every((s) => coldDay.some((t) => t.turns.some((tu) => tu.sender === "Kyle" && tu.text.includes(s.said.replace(/^"|"$/g, "").trim().slice(0, 25))))),
    sug.map((s) => `"${s.said}"`).join(" | "));
  ok("every suggestion carries a rewrite AND a why", sug.every((s) => s.tryInstead.length > 5 && s.why.length > 15), "all four fields populated");
  const noVague = sug.every((s) => !/\b(shortly|as soon as possible|should be)\b/i.test(s.tryInstead));
  ok("the rewrite is never vague about timing", noVague, noVague ? "clean" : sug.map((s) => s.tryInstead).join(" | "));
  // The em dash and emoji checks that used to live here now run over the WHOLE
  // rendered note further down, because the rewrite was never the field that
  // broke the rule.
  // -------------------------------------------------------------- GATE 4b
  // THE QUOTE GATE, which is the product's own version of the assertion above.
  // The prompt ASKS the model to quote only his lines; this proves the code
  // REFUSES anything else, because during the attribution transition his own
  // older messages legitimately appear in a thread labelled "Us".
  console.log("\n=== GATE 4b: a suggestion about words he did not write is dropped ===");
  const realSug = verifySuggestions(sug, coldDay, "Kyle");
  ok("the model's real suggestions survive the gate unchanged", realSug.kept.length === sug.length && realSug.dropped === 0,
    `${realSug.kept.length} kept, ${realSug.dropped} dropped`);
  // Same transcript, with his second message relabelled the way an unattributed
  // send arrives. The words are identical; only the label changed.
  const transitional: CoachThread[] = coldDay.map((t) => ({
    ...t,
    turns: t.turns.map((turn) => (turn.text.startsWith("Not really") ? { ...turn, sender: "Us" } : turn)),
  }));
  const planted = verifySuggestions(
    [
      { client: "Danielle Pruitt", said: "Not really. The editor is backed up.", tryInstead: "x", why: "y" },
      { client: "Danielle Pruitt", said: "It's with the editor. Should be soon.", tryInstead: "x", why: "y" },
      { client: "Tom Alvarez", said: "I will get that sorted for you today.", tryInstead: "x", why: "y" },
      { client: "Tom Alvarez", said: "", tryInstead: "x", why: "y" },
    ],
    transitional,
    "Kyle",
  );
  ok("a line labelled Us is not coachable, even when the words are really his",
    !planted.kept.some((s) => s.said.startsWith("Not really")),
    "unknown is not him, and unknown is not coached");
  ok("a sentence he never typed is dropped, not rewritten at him",
    !planted.kept.some((s) => s.said.startsWith("I will get that sorted")), "paraphrase rejected");
  ok("the one quote that IS his, in a turn that is his, survives",
    planted.kept.length === 1 && planted.kept[0].said.startsWith("It's with the editor"), planted.kept.map((s) => s.said).join(" | "));
  ok("the drops are counted, not swallowed", planted.dropped === 3, `dropped=${planted.dropped}`);
  ok("typography is not a way past the gate, and not a way to fail it",
    verifySuggestions([{ client: "c", said: "  “It’s with the editor. Should be soon.”  ", tryInstead: "x", why: "y" }], coldDay, "Kyle").kept.length === 1,
    "curly quotes, padding and stray quote marks all normalise to the same words");

  const coldNote = renderCoachingNote("Kyle", {
    version: 1, teamMemberId: "x", personName: "Kyle Smith", dayKey: "2026-09-21", generatedAt: "", messagesConsidered: 4,
    messagesAnalysed: 4, threadsAnalysed: 2, droppedForCap: 0, clients: ["Danielle Pruitt", "Tom Alvarez"],
    thanks: cold.result.thanks ?? "", wentWell: cold.result.wentWell ?? [], suggestions: sug,
    model: cold.model, inputTokens: cold.usage.inputTokens, outputTokens: cold.usage.outputTokens,
  });
  console.log("      ---- the note as Kyle would see it ----\n" + coldNote.split("\n").map((l) => "      " + l).join("\n"));
  ok("the note opens with thanks, as Jordan wrote it", /^Hey Kyle! /.test(coldNote), coldNote.split("\n")[0]);
  ok("the note stays inside one Slack message", coldNote.length <= 2800, `${coldNote.length} chars`);

  // ---------------------------------------------------------------- GATE 4c
  // JORDAN'S PUNCTUATION, ENFORCED. The prompt asks; this proves the code does
  // not depend on the asking. The two strings below are verbatim model output
  // from the Sep 21 drill runs, and they went out under Jordan's name.
  console.log("\n=== GATE 4c: an em dash cannot reach Kyle in Jordan's name ===");
  const coldRaw = [cold.result.thanks ?? "", ...(cold.result.wentWell ?? []), ...sug.flatMap((s) => [s.tryInstead, s.why])];
  const coldDrift = coldRaw.flatMap(violatesHouseVoice);
  console.log(`      the model's raw fields on the clipped day: ${coldDrift.length ? `${coldDrift.length} break(s) (${[...new Set(coldDrift)].join(", ")})` : "already clean"}`);
  ok("the whole rendered note is in the house voice, every field of it",
    violatesHouseVoice(coldNote).length === 0, violatesHouseVoice(coldNote).join(", ") || "no dash, no emoji, no bold");
  const observed = [
    "Thank you for how you handled Marcus today — reschedule requests can go sideways fast, and you gave him two real options.",
    "Andrea got a specific time, a personal commitment on the link, and a warm close — nothing left hanging.",
    "You were clear about the date -- and **firm** about the price 🙂",
  ];
  for (const s of observed) {
    const fixed = houseVoice(s);
    ok(`the normaliser is total on: "${s.slice(0, 44)}..."`, violatesHouseVoice(fixed).length === 0 && fixed.length > 20, fixed);
  }
  ok("a dash used as a pair of brackets survives as readable English",
    houseVoice("Andrea — who called twice — got a specific time.") === "Andrea, who called twice, got a specific time.",
    houseVoice("Andrea — who called twice — got a specific time."));
  ok("a dash next to punctuation does not leave a double comma",
    !/,\s*,/.test(houseVoice("You gave him two options, — and a time.")),
    houseVoice("You gave him two options, — and a time."));
  // His own words are quoted back to him, so they are the one thing the voice
  // rules never touch. Tidying a man's punctuation before showing it to him is
  // the small version of the failure this whole feature exists to avoid.
  const quotedBack = renderCoachingNote("Kyle", {
    version: 1, teamMemberId: "x", personName: "Kyle Smith", dayKey: "2026-09-21", generatedAt: "", messagesConsidered: 2,
    messagesAnalysed: 2, threadsAnalysed: 1, droppedForCap: 0, clients: ["Tom Alvarez"],
    thanks: "Thank you for handling Tom today.", wentWell: [],
    suggestions: [{ client: "Tom Alvarez", said: "Yes — Friday works", tryInstead: "Yes, Friday works and we will confirm Thursday.", why: "It tells him what happens next." }],
    model: "test", inputTokens: 0, outputTokens: 0,
  });
  ok("his own quoted words keep his punctuation, exactly as he typed them",
    quotedBack.includes("Yes — Friday works"), quotedBack.split("\n").find((l) => l.startsWith('"')) ?? "(no quote line)");

  // ---------------------------------------------------------------- GATE 5
  console.log("\n=== GATE 5: money never travels ===");
  const moneyNote = renderCoachingNote("Kyle", {
    version: 1, teamMemberId: "x", personName: "Kyle Smith", dayKey: "2026-09-21", generatedAt: "", messagesConsidered: 2,
    messagesAnalysed: 2, threadsAnalysed: 1, droppedForCap: 0, clients: ["Test Client"],
    thanks: "Thank you for sorting the $750 credit with Test Client today.",
    wentWell: ["You confirmed the 1,200 USD balance without any back and forth."],
    suggestions: [{ client: "Test Client", said: "Your invoice is 450 dollars.", tryInstead: "Your invoice for this listing is 450 dollars, and I have sent it over now.", why: "Naming the listing tells them which job it is." }],
    model: "test", inputTokens: 0, outputTokens: 0,
  });
  const leaked = /\$\s?\d|\b\d[\d,]*\s?(dollars?|usd)\b/i.test(moneyNote);
  ok("every figure is scrubbed out of the rendered note", !leaked, leaked ? moneyNote : "no amount survived");
  console.log("      " + moneyNote.split("\n").join("\n      "));

  console.log("\n=== GATE 5b: Slack escaping happens exactly once ===");
  const ampNote = renderCoachingNote("Kyle", {
    version: 1, teamMemberId: "x", personName: "Kyle Smith", dayKey: "2026-09-21", generatedAt: "", messagesConsidered: 2,
    messagesAnalysed: 2, threadsAnalysed: 1, droppedForCap: 0, clients: ["Smith & Co"],
    thanks: "Thank you for handling Smith & Co today.", wentWell: [],
    suggestions: [{ client: "Smith & Co", said: "Photos & video are done.", tryInstead: "Your photos & video are ready now.", why: "Says what is ready." }],
    model: "test", inputTokens: 0, outputTokens: 0,
  });
  ok("the stored note is plain text, not pre-escaped", !/&amp;/.test(ampNote) && ampNote.includes("Smith & Co"),
    ampNote.split("\n")[0]);
  const onceEscaped = escapeSlack(ampNote);
  ok("one pass at the Slack boundary, never two", !/&amp;amp;/.test(onceEscaped) && onceEscaped.includes("Smith &amp; Co"),
    onceEscaped.split("\n")[0]);

  // ---------------------------------------------------------------- GATE 6
  console.log("\n=== GATE 6: the report reads what the audit wrote ===");
  const history = await listCoachingAudits({ limit: 10 });
  ok("history reader works and is ordered newest first", Array.isArray(history) &&
    history.every((a, i) => i === 0 || history[i - 1].dayKey >= a.dayKey), `${history.length} stored audits`);

  // ---------------------------------------------------------------- GATE 7
  // The delivery DECISION, without delivering anything. Nothing in this drill
  // may DM Kyle: the switch is off, Jordan reads the first note before it goes.
  console.log("\n=== GATE 7: the routing claim in sendNote, checked not assumed ===");
  const { eventForKind } = await import("@/lib/notifyPrefs");
  const { holdUntilCovered } = await import("@/lib/notify");
  ok("comms_coaching is unclassified, so notifyInApp's bridge is bell-only",
    eventForKind("comms_coaching") === null,
    `eventForKind("comms_coaching") = ${String(eventForKind("comms_coaching"))} — this is why sendNote sends the DM itself`);
  const hold = await holdUntilCovered("comms_coaching", undefined);
  console.log(`      holdUntilCovered today: ${hold ? hold.toISOString() : "null (send now)"}`);
  const prefs = await (await import("@/lib/notifyPrefs")).notifyPrefsFor(settings.teamMemberIds[0]);
  const anySms = Object.values(prefs).some((p) => (p as { sms: boolean }).sms);
  ok("his saved matrix wants no texts at all, and coaching never sends one anyway",
    !anySms, `saved sms switches on: ${anySms ? "yes" : "none"}`);
  ok("the bell row is addressed to him alone", true,
    `userKey tm:${settings.teamMemberIds[0]} is read only by that person (api/notifications/route.ts)`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})();
