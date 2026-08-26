# RealTour Pilot — Operations Hub

In-house operations platform for a real estate media agency. See `README.md` for
the product overview and roadmap.

## Environment (important)
- **Use Node 20** — the system Node is 16 and too old. Run `nvm use` (an `.nvmrc`
  pins 20) or prepend `/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin` to PATH.
- Stack: Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4, **Prisma 6**
  (classic generator, **Postgres on Neon**).
- ⚠️ **THE DATABASE IS LIVE PRODUCTION.** The local `.env` points `DATABASE_URL`
  straight at the shared Neon Postgres the deployed app uses. Every query and
  write from this machine hits real business data. **NEVER run `npm run db:seed`
  or `npm run db:reset`** — they delete data (both now refuse hosted URLs unless
  forced). Safe: `npm run db:push` (additive schema changes), `npm run db:studio`,
  read-only `tsx` probes.
- `tsx` does NOT autoload `.env` (Prisma self-loads) — `set -a && source .env; set +a`
  for non-Prisma env vars.
- If dev 500s with a "global-error.js … React Client Manifest" error, `rm -rf .next`
  and restart. Don't run two dev servers against the same `.next`.

## Layout
- `src/app/` routes · `src/components/` UI · `src/lib/` (`prisma`, `queries`,
  `pipeline` domain config, `utils`) · `src/app/actions.ts` server actions.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
