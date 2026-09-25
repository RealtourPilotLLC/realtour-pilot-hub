// ---------------------------------------------------------------------------
// A HELD 1080p FILE — the words both sides of the button have to agree on
// (unified handoff O02/A39, Sep 25 2026).
//
// Pure, with no server-only import, so the client component that shows the
// choice (components/ops/HeldRender.tsx) and the server that enforces it
// (lib/topazJobs.ts resolveHeldTopazJob) read ONE sentence. The attestation is
// compared byte for byte on the server: a person accepting a file the hub could
// not check is putting their name to having listened to it, and a request that
// does not carry the sentence they were shown is refused rather than guessed.
// ---------------------------------------------------------------------------

/** What a person confirms before a held 1080p file is used anyway. */
export const HELD_ATTESTATION = "I played the 1080p file through and the sound and picture are right";

/** The two ways a held render ends — nothing else resolves one. */
export type HeldChoice = "use-original" | "accept-processed";
