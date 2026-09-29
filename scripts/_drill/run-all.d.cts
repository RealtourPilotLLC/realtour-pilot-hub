// Types for run-all.cjs's pure verdict rules (R06 second review, Sep 28 2026),
// which isolation-boundary.ts checks. Required as a module, run-all runs nothing.
export type Verdict = "PASS" | "FAIL" | "SKIPPED" | "RAN";
export declare function tally(text: string): string;
export declare function tallies(text: string): string[];
export declare function drillVerdict(run: { bannerSeen: boolean; timedOut: boolean; code: number | null; signal: string | null; text: string; timeoutS: number }): { verdict: Verdict; note: string };
export declare function suiteExitCode(rows: { verdict: Verdict }[], allowSkips: boolean): 0 | 1;
