// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The Gemini keys this phone can scan with, and the order they get used in.
//
// Why this exists: Gemini's free tier is rate limited, and on 2026-09-09 a
// single key ran out mid-session. One key meant scanning simply stopped until
// the quota reset. There was nothing wrong with the app, the account or the
// receipt.
//
// ---------------------------------------------------------------------------
// Round robin, then failover. Both, because neither alone is enough
// ---------------------------------------------------------------------------
// Round robin spreads the load, so three keys reach the wall roughly three
// times later than one. On its own it still fails a scan whose turn lands on
// an exhausted key while two healthy ones sit idle.
//
// Failover covers that: a 429 moves to the next key and the scan carries on.
// On its own it hammers key one until it dies, then key two, which wastes the
// per-minute headroom of the other keys entirely.
//
// So the cursor advances every scan (round robin) AND a 429 walks to the next
// key within the same scan (failover). See `scanReceipt.ts` for the walk.
//
// ---------------------------------------------------------------------------
// A caveat that decides whether any of this helps
// ---------------------------------------------------------------------------
// Gemini's free-tier quota is counted per Google Cloud PROJECT, not per key.
// Three keys minted inside one project share one limit and buy nothing. They
// have to come from different projects, or more simply different Google
// accounts. Nothing here can detect that, which is why Settings shows each
// key's own exhaustion separately: three keys going down together is the
// symptom of one shared quota.
//
// ---------------------------------------------------------------------------
// Storage, split the same way `instances.ts` splits it
// ---------------------------------------------------------------------------
// Labels, tails and exhaustion timestamps are ordinary app state and live in
// AsyncStorage. The secrets themselves live in SecureStore, one entry each,
// and are never written anywhere else -- not to the book, not to this repo.
// This file only stops there being room for exactly one.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getAiKey as getLegacyKey, clearLegacyAiKeyOnly } from './aiKey';

const LIST_KEY = 'mgc.aiKeys.v1';
const CURSOR_KEY = 'mgc.aiKeyCursor.v1';

/** SecureStore keys allow alphanumerics, `.`, `-` and `_` only. */
const secretKeyFor = (id: string) => `mgc_ai_key_${id}`;

/**
 * How long a 429 keeps a key at the back of the queue.
 *
 * Gemini rate limits come in two shapes and this number only fits one of them.
 * A per-minute limit clears in about a minute, which is what this is for. A
 * daily quota lasts until it resets and no cooldown would be right, so after
 * the minute the key rejoins the rotation and costs one failed request per
 * scan until it recovers. That is deliberate: guessing at a daily reset time
 * across time zones would strand a working key for hours.
 *
 * The Settings flag is NOT governed by this. It stays up until the key next
 * succeeds, because "this key hit its limit today" is worth seeing for longer
 * than sixty seconds.
 */
const COOLDOWN_MS = 60_000;

export type AiKeyProfile = {
  id: string;
  /** What the user calls it. Falls back to the masked tail. */
  name: string;
  /** Last 4 characters only, so this list can identify a key without holding it. */
  tail: string;
  /** ms epoch of the last 429 seen on this key, or null. Cleared by a success. */
  exhaustedAt: number | null;
};

export async function listAiKeys(): Promise<AiKeyProfile[]> {
  try {
    const raw = await AsyncStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiKeyProfile[]) : [];
  } catch {
    // A half-written blob must not stop you scanning.
    return [];
  }
}

async function writeList(list: AiKeyProfile[]): Promise<void> {
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(list));
}

function tailOf(apiKey: string): string {
  return apiKey.trim().slice(-4);
}

/** Shown wherever a key is named. Matches `maskKey` in `aiKey.ts`. */
export function labelFor(profile: AiKeyProfile): string {
  return profile.name?.trim() || `••••••••${profile.tail}`;
}

/**
 * Add a key and return the new list.
 *
 * Deduplicated on the secret itself rather than the tail, because two keys
 * from two different Google accounts can share four trailing characters and
 * refusing the second would silently defeat the whole point of this file.
 */
export async function addAiKey(apiKey: string, name?: string): Promise<AiKeyProfile[]> {
  const trimmed = apiKey.trim();
  if (!trimmed) return listAiKeys();

  const list = await listAiKeys();
  for (const profile of list) {
    if ((await readSecret(profile.id)) === trimmed) {
      // Already known. Re-adding it is how a user retries after a failure, so
      // treat it as "this one is fine now" rather than as an error.
      return clearExhausted(profile.id);
    }
  }

  const profile: AiKeyProfile = {
    // Timestamp alone collides when two are pasted in the same millisecond,
    // and forgetting one would then delete both. Same fix as `instances.ts`.
    id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: name?.trim() || '',
    tail: tailOf(trimmed),
    exhaustedAt: null,
  };

  await SecureStore.setItemAsync(secretKeyFor(profile.id), trimmed);
  await writeList([...list, profile]);
  return listAiKeys();
}

export async function renameAiKey(id: string, name: string): Promise<AiKeyProfile[]> {
  const list = await listAiKeys();
  await writeList(list.map((k) => (k.id === id ? { ...k, name: name.trim() } : k)));
  return listAiKeys();
}

export async function forgetAiKey(id: string): Promise<AiKeyProfile[]> {
  const list = await listAiKeys();
  await writeList(list.filter((k) => k.id !== id));
  await SecureStore.deleteItemAsync(secretKeyFor(id));
  return listAiKeys();
}

async function readSecret(id: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(secretKeyFor(id));
  } catch {
    return null;
  }
}

export async function markExhausted(id: string): Promise<AiKeyProfile[]> {
  const list = await listAiKeys();
  await writeList(list.map((k) => (k.id === id ? { ...k, exhaustedAt: Date.now() } : k)));
  return listAiKeys();
}

export async function clearExhausted(id: string): Promise<AiKeyProfile[]> {
  const list = await listAiKeys();
  await writeList(list.map((k) => (k.id === id ? { ...k, exhaustedAt: null } : k)));
  return listAiKeys();
}

/** True while a key is inside its cooldown and should go to the back. */
export function inCooldown(profile: AiKeyProfile, now = Date.now()): boolean {
  return profile.exhaustedAt != null && now - profile.exhaustedAt < COOLDOWN_MS;
}

/**
 * Every usable key, in the order this scan should try them.
 *
 * Round robin sets the starting point and the cursor moves on, so consecutive
 * scans do not all open on the same key. Keys inside their cooldown are moved
 * to the back rather than dropped: a scan with three tired keys should still
 * try all three before giving up, since the alternative is refusing to scan a
 * receipt that might well have gone through.
 *
 * A profile whose secret has vanished from SecureStore is skipped. That can
 * happen -- SecureStore is clearable independently of AsyncStorage -- and
 * sending `null` to Google would read as an auth failure rather than as the
 * missing key it is.
 */
export async function keysForScan(): Promise<{ id: string; secret: string; profile: AiKeyProfile }[]> {
  const list = await listAiKeys();
  if (list.length === 0) return [];

  const cursor = await getCursor();
  const start = ((cursor % list.length) + list.length) % list.length;
  const rotated = [...list.slice(start), ...list.slice(0, start)];
  await AsyncStorage.setItem(CURSOR_KEY, String((start + 1) % list.length));

  const now = Date.now();
  const fresh = rotated.filter((k) => !inCooldown(k, now));
  const tired = rotated.filter((k) => inCooldown(k, now));

  const out: { id: string; secret: string; profile: AiKeyProfile }[] = [];
  for (const profile of [...fresh, ...tired]) {
    const secret = await readSecret(profile.id);
    if (secret) out.push({ id: profile.id, secret, profile });
  }
  return out;
}

async function getCursor(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(CURSOR_KEY);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Fold a key saved before this list existed into it.
 *
 * A phone that has been scanning for weeks has its key under the old single
 * `ai_gemini_api_key` entry and nothing in this list, so without this the
 * feature would look empty on exactly the installs that need it. The old entry
 * is removed once copied, so there is one place a key lives and no chance of
 * the two disagreeing later.
 *
 * Called on Settings mount and before a scan. A no-op once there is nothing
 * left to adopt.
 */
export async function adoptLegacyKey(): Promise<AiKeyProfile[]> {
  const legacy = await getLegacyKey();
  if (!legacy) return listAiKeys();

  const list = await addAiKey(legacy, 'First key');
  await clearLegacyAiKeyOnly();
  return list;
}
