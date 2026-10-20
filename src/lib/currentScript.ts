// The scripting platform's current crew script for a job, as the script card
// reads it (Oct 20 2026; lib/scriptSync writes the fields). Plain data, so a
// server loader (lib/shoot) and a page can both build it.

export type CurrentScript = {
  script: string | null;
  version: number | null;
  versionAt: string | null;
  onSiteBy: string | null;
  draftVersion: number | null;
  status: string | null;
  clientVersion: number | null;
  clientSentAt: string | null;
};

const iso = (d: Date | string | null | undefined) => (d == null ? null : typeof d === "string" ? d : d.toISOString());

/** The card's `current` prop from a job row (Dates or ISO strings). */
export function currentScriptOf(p: {
  scriptingScript?: string | null; scriptingVersion?: number | null; scriptingVersionAt?: Date | string | null; scriptingOnSiteBy?: string | null;
  scriptingDraftVersion?: number | null; scriptingStatus?: string | null; scriptingClientVersion?: number | null; scriptingClientSentAt?: Date | string | null;
}): CurrentScript {
  return {
    script: p.scriptingScript ?? null, version: p.scriptingVersion ?? null, versionAt: iso(p.scriptingVersionAt), onSiteBy: p.scriptingOnSiteBy ?? null,
    draftVersion: p.scriptingDraftVersion ?? null, status: p.scriptingStatus ?? null, clientVersion: p.scriptingClientVersion ?? null, clientSentAt: iso(p.scriptingClientSentAt),
  };
}

