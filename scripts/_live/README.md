# scripts/_live — these touch PRODUCTION

Every script in this folder connects to the live Neon database (the `.env`
`DATABASE_URL`), and some also make real calls to Aryeo, OpenAI or other
providers. They are walkthroughs and read-only measurements that were run on
purpose, with Jordan's say-so, against real data.

**They are not drills.** Isolated drills live in `scripts/_drill/` and boot their
own throwaway Postgres (`bootDrillDb` / PGlite). Run them with the committed
runner — `npm run drills` (all), `npm run drills -- scripts/_drill/<file>.ts`
(some), `npm run drills:boundary` (the isolation boundary's own proof). It only
ever picks from `scripts/_drill/`, refuses a file from here by name, and runs
every drill inside the isolation boundary (`scripts/_drill/_isolation.cjs`:
database keys on a dead loopback sentinel, non-loopback sockets and Prisma
engines refused, children included). The old scratch runner
(`scratchpad/run-iso-drills.sh`) is retired: it skipped 11 drills and
`kill -9`'d every port from 5480 to 5660, the isolated demo's included.

The boundary switches itself on by WHICH SCRIPT runs, so the scripts here keep
working exactly as before even though several load `_drill-preload.cjs` —
unless a drill starts one, in which case it runs isolated too.

Before running anything here:
- Read its header. Most force `default_transaction_read_only=on` and prove a
  refused write first; a few (e.g. `jordan-call-path.ts`) write tagged rows to
  the TEST client only and make a paid AI call.
- Never run one as part of a test sweep, from a builder agent, or unattended.
- Never use production for race tests or failure injection (the real-Postgres
  race drills in `scripts/_drill/` use `tools/realpg` instead).

Moved here on Sep 28 2026 after a builder ran `product-eligibility.ts`
believing it was isolated. The read-only guard refused both attempted
writes (25006), so nothing was written.
