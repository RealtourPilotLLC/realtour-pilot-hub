import type { Instrumentation } from "next";

// ---------------------------------------------------------------------------
// SERVER ERROR CAPTURE (Oct 6 2026). Next calls onRequestError for every
// uncaught error in a server component render, a route handler, a server
// action or the middleware (proxy). Each one is recorded in the error tracker
// (src/lib/errorTracker.ts → ErrorEvent, shown on /settings/errors) and a new
// one alerts Jordan. Node runtime only — the tracker needs Prisma. Recording is
// time-capped and can never throw back into the request.
// ---------------------------------------------------------------------------
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { captureRequestError } = await import("@/lib/errorTracker");
    await captureRequestError(err, request, context);
  } catch {
    /* the error tracker must never add a second failure to the first */
  }
};
