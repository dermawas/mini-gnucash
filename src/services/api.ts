// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The only way this app talks to the ledger.
//
// Every call is a POST to a PostgREST RPC. There are no table endpoints,
// because the Postgres role behind the JWT has no table privileges at all --
// GET /accounts returns 403 by design. See sql/10_roles_and_grants.sql.

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Credential keys. Kept behind a helper rather than used as bare strings so
 * there is exactly one place to change if a profile concept ever appears.
 * Its predecessor learned this the hard way: unscoped keys leaked one account's
 * server credentials into another account on the same device.
 */
export function credentialKeys() {
  return { urlKey: 'mgc_postgrest_url', tokenKey: 'mgc_jwt_token' } as const;
}

/**
 * 8 seconds. Deliberately short rather than generous.
 *
 * Off-VPN, a connection to a private address does not fail fast -- it hangs on
 * the OS default connect timeout, which is long enough that a user assumes the
 * app is broken. There is no queue behind this to catch a premature abort:
 * a timed-out read just gets retried, and a timed-out *write* is resolved
 * definitively by checkRequest() rather than guessed at. So failing fast costs
 * nothing and reads far better.
 */
const FETCH_TIMEOUT_MS = 8000;

/** Vision inference legitimately runs 10-30s, so receipt scanning gets its own. */
export const AI_TIMEOUT_MS = 60000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PostgREST wraps a Postgres RAISE EXCEPTION as {code, details, hint, message}.
 * The `message` is the sentence the SQL author wrote for the user, so it is
 * worth digging out -- the RPCs in sql/ deliberately phrase their errors as
 * instructions ("Close it there and try again"), and showing raw JSON instead
 * throws that away.
 */
function extractErrorMessage(rawText: string, status: number): string {
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // not JSON; fall through
  }
  return rawText?.trim() || `HTTP ${status}`;
}

/**
 * Why these are distinct rather than one `error` case:
 *
 *   offline       come back when you are on the VPN. Nothing is wrong.
 *   unauthorized  your credentials are wrong. Go to Settings. Retrying will
 *                 never help, and telling someone to "check their connection"
 *                 when the token is bad sends them looking in the wrong place.
 *   locked        GnuCash desktop has the book. Reads still work; only writes
 *                 are blocked. Conflating this with offline would hide a
 *                 perfectly usable app behind a false "no connection".
 *   rejected      the server reached a decision and said no, with a reason
 *                 worth showing verbatim.
 */
/** The ways a call can fail. Named so other modules can narrow on it. */
export type RpcFailureKind = 'offline' | 'unauthorized' | 'locked' | 'rejected';

export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'offline'; error: string }
  | { ok: false; kind: 'unauthorized'; error: string }
  | { ok: false; kind: 'locked'; error: string }
  | { ok: false; kind: 'rejected'; error: string };

export type Credentials = { url: string; token: string };

/** Android rejects a schemeless URL outright, and people type "10.8.0.1:3003". */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export async function loadCredentials(): Promise<Credentials | null> {
  const { urlKey, tokenKey } = credentialKeys();
  const [url, token] = await Promise.all([
    SecureStore.getItemAsync(urlKey),
    SecureStore.getItemAsync(tokenKey),
  ]);
  if (!url || !token) return null;
  return { url, token };
}

export async function saveCredentials(url: string, token: string): Promise<void> {
  const { urlKey, tokenKey } = credentialKeys();
  await SecureStore.setItemAsync(urlKey, normalizeUrl(url));
  await SecureStore.setItemAsync(tokenKey, token.trim());
}

export async function clearCredentials(): Promise<void> {
  const { urlKey, tokenKey } = credentialKeys();
  await Promise.all([
    SecureStore.deleteItemAsync(urlKey),
    SecureStore.deleteItemAsync(tokenKey),
  ]);
}

/** Postgres raises this SQLSTATE from mgc_assert_unlocked(). */
const LOCK_NOT_AVAILABLE = '55P03';

export async function callRpc<T>(
  fn: string,
  params: Record<string, unknown> = {},
  creds?: Credentials | null,
): Promise<RpcResult<T>> {
  const c = creds ?? (await loadCredentials());
  if (!c) {
    return { ok: false, kind: 'offline', error: 'No server configured yet.' };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(`${c.url}/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.token}`,
      },
      body: JSON.stringify(params),
    });
  } catch (err: any) {
    // A thrown fetch means the server was never reached: DNS failure, connection
    // refused, or our own abort. All of them mean the same thing to the user.
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      kind: 'offline',
      error: aborted
        ? 'Connection timed out. Are you on the VPN?'
        : 'Could not reach your ledger. Are you on the VPN?',
    };
  }

  const text = await response.text();

  if (response.status === 401 || response.status === 403) {
    // 403 also covers a role that lost its function grants -- still a
    // credentials problem from the user's point of view, still not retryable.
    return {
      ok: false,
      kind: 'unauthorized',
      error: extractErrorMessage(text, response.status),
    };
  }

  if (!response.ok) {
    let code = '';
    try {
      code = JSON.parse(text)?.code ?? '';
    } catch {
      /* leave blank */
    }
    const kind = code === LOCK_NOT_AVAILABLE ? 'locked' : 'rejected';
    return { ok: false, kind, error: extractErrorMessage(text, response.status) };
  }

  try {
    return { ok: true, data: (text ? JSON.parse(text) : null) as T };
  } catch {
    return { ok: false, kind: 'rejected', error: 'Server sent a response this app could not read.' };
  }
}

// ---------------------------------------------------------------------------
// In-flight write marker
// ---------------------------------------------------------------------------
// The one piece of state this app persists besides credentials and the account
// cache, and it exists for exactly one failure:
//
//   the server commits -> the connection drops -> the response never arrives
//
// PostgREST runs each request in a single transaction, so the book is never
// left half-written. But the phone genuinely does not know whether it worked.
// Without a marker, killing the app there loses the request id, the user
// re-enters, a NEW id is generated, and a committed transfer is duplicated.
//
// This is NOT a sync queue returning. It holds one id with a definite
// lifetime -- written before a request, deleted once its fate is known -- and
// it never holds ledger data the book does not already have.

const IN_FLIGHT_KEY = 'mgc_in_flight_write';

export type InFlightWrite = { requestId: string; label: string; startedAt: string };

export async function markInFlight(requestId: string, label: string): Promise<void> {
  const payload: InFlightWrite = { requestId, label, startedAt: new Date().toISOString() };
  try {
    await AsyncStorage.setItem(IN_FLIGHT_KEY, JSON.stringify(payload));
  } catch {
    // Best effort. Losing the marker degrades to today's ambiguity, which is
    // no worse than not having tried.
  }
}

export async function clearInFlight(): Promise<void> {
  try {
    await AsyncStorage.removeItem(IN_FLIGHT_KEY);
  } catch {
    /* best effort */
  }
}

export async function readInFlight(): Promise<InFlightWrite | null> {
  try {
    const raw = await AsyncStorage.getItem(IN_FLIGHT_KEY);
    return raw ? (JSON.parse(raw) as InFlightWrite) : null;
  } catch {
    return null;
  }
}

export type CheckRequestResult =
  | { found: false }
  | { found: true; deleted_since: true; tx_guid: string }
  | { found: true; deleted_since: false; tx_guid: string; description: string; post_date: string };

/** Did an interrupted write actually land? The only honest way to find out. */
export function checkRequest(requestId: string) {
  return callRpc<CheckRequestResult>('mgc_check_request', { p_request_id: requestId });
}

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export type PingResult = {
  ok: boolean;
  server_time: string;
  book_locked: boolean;
  locked_by: string | null;
  trading_accounts: boolean;
  account_count: number;
};

export function ping(creds?: Credentials | null) {
  return callRpc<PingResult>('mgc_ping', {}, creds);
}

export type Account = {
  guid: string;
  name: string;
  account_type: string;
  parent_guid: string | null;
  placeholder: number;
  hidden: number;
  full_path: string;
  depth: number;
  commodity_guid: string | null;
  commodity_scu: number;
  commodity_mnemonic: string | null;
  commodity_namespace: string | null;
  description: string;
};

export type Balance = {
  guid: string;
  commodity_mnemonic: string | null;
  commodity_scu: number;
  balance_total: number;
  balance_present: number;
  balance_cleared: number;
  balance_reconciled: number;
  split_count: number;
  /** null when the subtree spans more than one commodity -- render "--", not 0. */
  balance_subtree: number | null;
};

export type RegisterRow = {
  tx_guid: string;
  split_guid: string;
  post_date: string;
  num: string;
  description: string;
  memo: string;
  action: string;
  reconcile_state: string;
  /** In the ACCOUNT's own commodity. This is what a balance is made of. */
  quantity: number;
  /** In the TRANSACTION's currency. Differs from quantity on a cross-currency entry. */
  value: number;
  tx_currency: string | null;
  split_count: number;
  other_splits: { guid: string; name: string; quantity: number; commodity: string | null }[];
};

export type Register = {
  account_guid: string;
  account_name: string;
  account_type: string;
  commodity: string | null;
  commodity_scu: number;
  window_days: number;
  opening_balance: number;
  row_count: number;
  total_in_window: number;
  truncated: boolean;
  rows: RegisterRow[];
};

export function getBalances() {
  return callRpc<Balance[]>('mgc_get_balances');
}

export function getRegister(accountGuid: string, days = 90, limit = 200) {
  return callRpc<Register>('mgc_get_register', {
    p_account_guid: accountGuid,
    p_days: days,
    p_limit: limit,
  });
}

export type TransferResult = {
  status: 'recorded' | 'already_recorded';
  tx_guid: string;
  form?: 'trading' | 'simple';
  cross_currency?: boolean;
  from_currency?: string;
  to_currency?: string;
  /** Computed by the SERVER from the two amounts. Show this back, not the input. */
  derived_rate?: number | null;
  split_guids?: string[];
};

/**
 * Note there is no rate argument, and there must never be one. The server
 * derives it from the two amounts. See the header of sql/40_transfer.sql.
 */
export async function transfer(args: {
  requestId: string;
  fromGuid: string;
  fromAmount: number;
  toGuid: string;
  toAmount: number;
  postDate: string;
  description: string;
}): Promise<RpcResult<TransferResult>> {
  await markInFlight(args.requestId, `Transfer ${args.description || ''}`.trim());
  const result = await callRpc<TransferResult>('mgc_transfer', {
    p_request_id: args.requestId,
    p_from_guid: args.fromGuid,
    p_from_amount: args.fromAmount,
    p_to_guid: args.toGuid,
    p_to_amount: args.toAmount,
    p_post_date: args.postDate,
    p_description: args.description,
  });

  // Clear the marker only when the outcome is KNOWN. A rejection is a known
  // outcome -- nothing was written. An offline result is not: the write may
  // have committed with the response lost, which is precisely what the marker
  // is for, so it stays put for checkRequest() to resolve later.
  if (result.ok || result.kind === 'rejected' || result.kind === 'unauthorized') {
    await clearInFlight();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Chart-of-accounts cache
// ---------------------------------------------------------------------------
// The ONLY thing cached for offline use, and the asymmetry is deliberate:
// account structure is stable, money is not. A stale account list is a mild
// inconvenience; a stale balance shown as current is the exact class of silent
// wrongness this project exists to avoid. So balances and registers are never
// cached -- off-VPN those screens show nothing rather than something wrong.

const COA_CACHE_KEY = 'mgc_coa_cache';

type CoaCache = { accounts: Account[]; cachedAt: string };

export type AccountsResult =
  | { ok: true; accounts: Account[]; fromCache: false }
  | { ok: true; accounts: Account[]; fromCache: true; cachedAt: string }
  | { ok: false; kind: RpcFailureKind; error: string };

export async function getAccounts(creds?: Credentials | null): Promise<AccountsResult> {
  const live = await callRpc<Account[]>('mgc_get_accounts', {}, creds);

  if (live.ok) {
    try {
      const payload: CoaCache = { accounts: live.data, cachedAt: new Date().toISOString() };
      await AsyncStorage.setItem(COA_CACHE_KEY, JSON.stringify(payload));
    } catch {
      /* caching is best effort */
    }
    return { ok: true, accounts: live.data, fromCache: false };
  }

  // Fall back to cache ONLY when the server was never reached. A server that
  // answered and said no -- a bad token, a revoked grant -- is a real, current
  // problem the user needs to see now, and stale data must not paper over it.
  if (live.kind !== 'offline') {
    return { ok: false, kind: live.kind, error: live.error };
  }

  try {
    const raw = await AsyncStorage.getItem(COA_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as CoaCache;
      return { ok: true, accounts: cached.accounts, fromCache: true, cachedAt: cached.cachedAt };
    }
  } catch {
    /* fall through to the offline error */
  }

  return { ok: false, kind: 'offline', error: live.error };
}

export async function clearAccountCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(COA_CACHE_KEY);
  } catch {
    /* best effort */
  }
}
