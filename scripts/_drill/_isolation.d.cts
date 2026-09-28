// Types for _isolation.cjs (R06, Sep 28 2026). The module is plain CommonJS so
// it can load through `node --require` and NODE_OPTIONS before any TypeScript
// loader exists; the harness, the lint and the boundary drill import it from TS.

export type IsolationRole = "root" | "descendant" | "inactive";

export type IsolationState = {
  active: boolean;
  role: IsolationRole;
  /** The script this process runs (real path), or null for eval/stdin/workers. */
  entry: string | null;
  /** The entry is a drill (scripts/_drill/**) or an isolated tool. */
  drillEntry: boolean;
  /** Every refusal made in this process, in order (tcp://, tls://, https://, prisma://, exec://). */
  blocked: string[];
};

export type EnvLike = Record<string, string | undefined>;

export declare const SENTINEL_URL: string;
export declare const MARKER: "RTP_DRILL_ISOLATION";
export declare const BANNER: string;
export declare const DB_KEYS: readonly string[];
export declare const NO_DATABASE: string;
export declare const SELF: string;
export declare const DRILL_DIR: string;
export declare const REPO: string;
export declare const RUNNER: string;

export declare function activate(): IsolationState;
export declare function state(): IsolationState;
export declare function assertActive(caller?: string): void;
export declare function onBlocked(fn: (entry: string) => void): () => void;

export declare function decide(opts: { entry: string | null; env: EnvLike; drillDir?: string; tools?: string[] }): {
  role: IsolationRole;
  drillEntry: boolean;
};
export declare function isDrillDbUrl(url: string | undefined | null): boolean;
export declare function isSentinelUrl(url: string | undefined | null): boolean;
export declare function assertLoopbackDbUrl(url: string): void;
export declare function isLoopbackHost(host: string | undefined | null): boolean;
export declare function dotEnvKeyNames(): string[];
export declare function secretKeyNames(): string[];
export declare function repinChildEnv(env: EnvLike): Record<string, string>;
export declare function childVerdict(file: string, args: readonly string[], env: EnvLike): { ok: true } | { ok: false; message: string };
export declare function judgeEngineConfig(
  config: { datamodel?: string; env?: EnvLike; datasourceOverrides?: Record<string, string> },
  adapter?: unknown,
): { ok: true } | { ok: false; message: string; blocked?: string };
export declare function withIsolationRequire(nodeOptions: string | undefined): string;
