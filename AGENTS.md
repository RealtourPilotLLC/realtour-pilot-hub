# RealTour Pilot — Operations Hub

In-house operations platform for a real estate media agency. See `README.md` for
the product overview and roadmap.

## Environment (important)
- **Use Node 20** — the system Node is 16 and too old. Run `nvm use` (an `.nvmrc`
  pins 20) or prepend `/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin` to PATH.
- Stack: Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4, **Prisma 6**
  (classic generator, SQLite at `prisma/dev.db`).
- DB commands: `npm run db:push`, `npm run db:seed`, `npm run db:studio`, `npm run db:reset`.
- If dev 500s with a "global-error.js … React Client Manifest" error, `rm -rf .next`
  and restart. Don't run two dev servers against the same `.next`.

## Layout
- `src/app/` routes · `src/components/` UI · `src/lib/` (`prisma`, `queries`,
  `pipeline` domain config, `utils`) · `src/app/actions.ts` server actions.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
