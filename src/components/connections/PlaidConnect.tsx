"use client";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import {
  Landmark, ShieldCheck, Plus, RefreshCw, Loader2, Building2, User, Trash2, CheckCircle2, AlertTriangle, History,
} from "lucide-react";
import {
  savePlaidCredsAction, getPlaidLinkToken, exchangePlaidPublicToken, syncPlaidNow, backfillPlaidNow, disconnectPlaidBank, tagPlaidAccount,
} from "@/app/connections/banks/actions";

export type PlaidAccountView = {
  id: string; accountId: string; name: string | null; officialName: string | null;
  mask: string | null; type: string | null; subtype: string | null;
  currentBalance: number | null; availableBalance: number | null; isBusiness: boolean | null;
};
export type PlaidBankView = {
  id: string; institutionName: string | null; status: string; lastError: string | null;
  lastSyncedAt: string | null; accounts: PlaidAccountView[];
};

const money = (n: number | null) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LINK_TOKEN_KEY = "plaid_link_token";

// Auto-opens Plaid Link once its token is ready, then reports the public token
// back. Bank credentials are entered on Plaid's own screen — never here.
// `receivedRedirectUri` resumes the flow after an OAuth bank (Capital One,
// Chase, …) bounces the browser back to /connections/banks?oauth_state_id=…
function LinkLauncher({ token, receivedRedirectUri, onDone }: { token: string; receivedRedirectUri?: string; onDone: () => void }) {
  const [, start] = useTransition();
  const { open, ready } = usePlaidLink({
    token,
    ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
    onSuccess: (publicToken) => start(async () => { await exchangePlaidPublicToken(publicToken); onDone(); }),
    onExit: () => onDone(),
  });
  useEffect(() => { if (ready) open(); }, [ready, open]);
  return null;
}

export function PlaidConnect({
  configured, env, banks, txnCount,
}: { configured: boolean; env: string | null; banks: PlaidBankView[]; txnCount: number }) {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [oauthRedirect, setOauthRedirect] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // OAuth return: Plaid sent the browser back with ?oauth_state_id=… — resume
  // Link using the same token we stashed before the redirect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.search.includes("oauth_state_id")) return;
    const saved = window.localStorage.getItem(LINK_TOKEN_KEY);
    if (saved) {
      setLinkToken(saved);
      setOauthRedirect(window.location.href);
    }
  }, []);

  const startConnect = useCallback(() => {
    setErr(null); setBusy("link"); setOauthRedirect(undefined);
    getPlaidLinkToken()
      .then((t) => { window.localStorage.setItem(LINK_TOKEN_KEY, t); setLinkToken(t); })
      .catch((e) => setErr(e?.message ?? "Couldn't start the bank connection."))
      .finally(() => setBusy(null));
  }, []);

  const onLinkDone = useCallback(() => {
    setLinkToken(null);
    setOauthRedirect(undefined);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LINK_TOKEN_KEY);
      // Strip the oauth query params so a refresh doesn't re-trigger the resume.
      if (window.location.search.includes("oauth_state_id")) {
        window.history.replaceState({}, "", "/connections/banks");
      }
    }
    router.refresh();
  }, [router]);

  return (
    <div className="space-y-6">
      {/* Trust banner */}
      <div className="flex items-start gap-3 rounded-2xl border border-brand/30 bg-brand-soft/40 p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" />
        <div className="text-sm">
          <p className="font-medium">Read-only, and your logins stay private.</p>
          <p className="text-muted">
            Plaid can <span className="font-medium">read</span> your transactions and balances — it cannot move money.
            You sign in to each bank on Plaid&apos;s own secure screen; those logins never touch this app, and your
            keys are encrypted at rest.
          </p>
        </div>
      </div>

      {err && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {err}
        </div>
      )}

      {!configured ? (
        <CredsForm onSaved={() => router.refresh()} defaultEnv={env} />
      ) : (
        <>
          {/* Connect + sync controls */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={startConnect}
              disabled={busy === "link"}
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {busy === "link" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Connect a bank
            </button>
            <button
              onClick={() => { setBusy("sync"); setErr(null); syncPlaidNow().then(() => router.refresh()).catch((e) => setErr(e?.message ?? "Sync failed")).finally(() => setBusy(null)); }}
              disabled={busy != null || banks.length === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              {busy === "sync" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Sync now
            </button>
            <button
              onClick={() => { setBusy("backfill"); setErr(null); backfillPlaidNow().then(() => router.refresh()).catch((e) => setErr(e?.message ?? "Backfill failed")).finally(() => setBusy(null)); }}
              disabled={busy != null || banks.length === 0}
              title="Re-pull the full 2 years of history for every connected account"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              {busy === "backfill" ? <Loader2 className="size-4 animate-spin" /> : <History className="size-4" />}
              Pull full history
            </button>
            <span className="text-xs text-muted-2">
              {banks.length} bank{banks.length === 1 ? "" : "s"} · {txnCount.toLocaleString()} transactions ·{" "}
              <span className="uppercase tracking-wide">{env}</span>
            </span>
          </div>

          {linkToken && <LinkLauncher token={linkToken} receivedRedirectUri={oauthRedirect} onDone={onLinkDone} />}

          {banks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-surface p-8 text-center">
              <Landmark className="mx-auto size-8 text-muted-2" />
              <p className="mt-2 text-sm font-medium">No banks connected yet</p>
              <p className="mt-1 text-xs text-muted">
                Click <span className="font-medium">Connect a bank</span> and link your personal account (…0942),
                personal Venmo, and Capital One card so the Hub can see the full money picture.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {banks.map((b) => (
                <BankCard key={b.id} bank={b} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CredsForm({ onSaved, defaultEnv }: { onSaved: () => void; defaultEnv: string | null }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [env, setEnv] = useState<string>(defaultEnv ?? "production");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault(); setError(null);
        start(async () => {
          try { await savePlaidCredsAction(clientId, secret, env === "sandbox" ? "sandbox" : "production"); onSaved(); }
          catch (er) { setError(er instanceof Error ? er.message : "Couldn't save"); }
        });
      }}
      className="space-y-4 rounded-2xl border border-border bg-surface p-5"
    >
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Landmark className="size-4 text-brand" /> Add your Plaid keys</h2>
        <p className="mt-1 text-xs text-muted">
          From your Plaid dashboard → Developers → Keys. Paste the <span className="font-medium">client_id</span> and the
          secret for the environment you pick. They&apos;re encrypted the moment you save — this app never shows them again.
        </p>
      </div>
      <label className="block">
        <span className="text-xs font-medium text-muted">client_id</span>
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} required autoComplete="off" spellCheck={false}
          className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm tabular-nums outline-none focus:border-brand" placeholder="e.g. 65a1…" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-muted">secret</span>
        <input value={secret} onChange={(e) => setSecret(e.target.value)} required type="password" autoComplete="off" spellCheck={false}
          className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand" placeholder="paste your secret" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-muted">environment</span>
        <select value={env} onChange={(e) => setEnv(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand">
          <option value="production">Production — connect real bank accounts</option>
          <option value="sandbox">Sandbox — test with fake data first</option>
        </select>
        <span className="mt-1 block text-[11px] text-muted-2">
          To connect your actual accounts, use <span className="font-medium">Production</span> and its matching secret.
        </span>
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
      <button type="submit" disabled={pending}
        className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Save keys
      </button>
    </form>
  );
}

function BankCard({ bank }: { bank: PlaidBankView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <section className="rounded-2xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <Landmark className="size-4 text-brand" />
          <span className="text-sm font-semibold">{bank.institutionName ?? "Bank"}</span>
          {bank.status === "ERROR" && <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger">Needs attention</span>}
        </div>
        <div className="flex items-center gap-3">
          {bank.lastSyncedAt && <span className="text-[11px] text-muted-2">synced {new Date(bank.lastSyncedAt).toLocaleDateString()}</span>}
          <button
            onClick={() => { if (!confirm(`Disconnect ${bank.institutionName ?? "this bank"}? Its transactions will be removed.`)) return; setBusy(true); disconnectPlaidBank(bank.id).then(() => router.refresh()).finally(() => setBusy(false)); }}
            disabled={busy} title="Disconnect"
            className="text-muted-2 hover:text-danger disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          </button>
        </div>
      </div>
      {bank.lastError && <div className="border-b border-border bg-danger/5 px-5 py-2 text-[11px] text-danger">{bank.lastError}</div>}
      <div className="divide-y divide-border/60">
        {bank.accounts.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {a.name ?? a.officialName ?? "Account"}{a.mask ? <span className="text-muted-2"> ··{a.mask}</span> : null}
              </div>
              <div className="text-[11px] capitalize text-muted-2">{[a.subtype ?? a.type, a.availableBalance != null ? `${money(a.availableBalance)} available` : null].filter(Boolean).join(" · ")}</div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold tabular-nums">{money(a.currentBalance)}</span>
              <BizToggle account={a} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function BizToggle({ account }: { account: PlaidAccountView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const set = (v: boolean | null) => start(async () => { await tagPlaidAccount(account.id, v); router.refresh(); });
  const base = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition";
  return (
    <div className="flex items-center gap-1" aria-busy={pending}>
      <button onClick={() => set(true)} className={`${base} ${account.isBusiness === true ? "bg-success/15 text-success" : "text-muted-2 hover:bg-surface-2"}`}>
        <Building2 className="size-3" /> Business
      </button>
      <button onClick={() => set(false)} className={`${base} ${account.isBusiness === false ? "bg-brand/15 text-brand" : "text-muted-2 hover:bg-surface-2"}`}>
        <User className="size-3" /> Personal
      </button>
    </div>
  );
}
