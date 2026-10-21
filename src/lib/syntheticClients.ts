import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isSyntheticClientRow } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// THE TEST CLIENTS' IDS, READ ONE WAY (Oct 21 2026, audit H9).
//
// About twenty screens and sweeps read the WHOLE client table and kept the few
// rows isSyntheticClientRow accepts, on every page load and every cron tick,
// to hide test records. They read this instead.
//
// The database may only NARROW the candidates; testClients.ts still decides.
// The rule there is /\btest\b|\bjohn doe\b/i, and a JavaScript /i regex without
// the u flag folds case for ASCII letters only, so every name it accepts
// contains "test" or "john doe" in some ASCII casing, which Postgres ILIKE
// (Prisma `mode: "insensitive"`) always finds. The filter below is therefore a
// superset of the synthetic rows and cannot miss one; the never-synthetic ids
// are refused by isSyntheticClientRow exactly as before.
//
// React `cache`: one read per page render, and a plain read anywhere else (a
// cron, a server action). Nothing is kept between requests.
// ---------------------------------------------------------------------------

/** Names that MIGHT be synthetic. A superset by construction; never a decision on its own. */
export const SYNTHETIC_CANDIDATE_WHERE = {
  OR: [{ name: { contains: "test", mode: "insensitive" } }, { name: { contains: "john doe", mode: "insensitive" } }],
} satisfies Prisma.ClientWhereInput;

/** The synthetic (TEST) client rows, id and name. */
export const syntheticClientRows = cache(async (): Promise<{ id: string; name: string }[]> =>
  (await prisma.client.findMany({ where: SYNTHETIC_CANDIDATE_WHERE, select: { id: true, name: true } })).filter(isSyntheticClientRow));

/** The synthetic (TEST) clients' ids: what "hide test records" excludes. */
export const syntheticClientIds = cache(async (): Promise<string[]> => (await syntheticClientRows()).map((c) => c.id));
