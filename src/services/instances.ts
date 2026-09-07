// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The ledgers this phone knows how to reach.
//
// Why this exists: a JWT is signed by one PostgREST instance's secret, so a
// token and a URL are a pair -- the production token returns 401 against the
// dev clone and the reverse is also true. Settings therefore refused to let
// the URL be edited on its own, which was correct, but the only way to change
// it was Disconnect, and that DISCARDED both. Switching between the real book
// and the clone meant retyping a 117-character JWT from scratch, twice in one
// evening, neither time realistically by hand.
//
// So: remember the pairs, switch between them with a tap. The coupling that
// made the old behaviour correct is preserved -- a URL is never separated from
// its token -- it is just no longer thrown away.
//
// Storage is split deliberately. Names and URLs are ordinary app state and
// live in AsyncStorage; tokens are credentials and live in SecureStore, one
// key each. Nothing here weakens where a token is kept, it only stops there
// being room for exactly one.
//
// This is phone-local state, which this project is otherwise sparing with.
// It holds no ledger data -- an address, a label, and a credential that was
// already on the device.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { saveCredentials, clearCredentials, loadCredentials, normalizeUrl } from './api';

const LIST_KEY = 'mgc.instances.v1';
const ACTIVE_KEY = 'mgc.activeInstance.v1';

/** SecureStore keys allow alphanumerics, `.`, `-` and `_` only. */
const tokenKeyFor = (id: string) => `mgc_instance_token_${id}`;

export type Instance = {
  id: string;
  /** What the user calls it. Falls back to the host:port when left blank. */
  name: string;
  url: string;
};

export async function listInstances(): Promise<Instance[]> {
  try {
    const raw = await AsyncStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Instance[]) : [];
  } catch {
    // A half-written blob must not lock you out of your own ledger.
    return [];
  }
}

export async function getActiveId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

/** `http://10.8.0.1:3004` -> `10.8.0.1:3004`, for a default label. */
function labelFromUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * Store a URL/token pair and make it the active one.
 *
 * Keyed by normalised URL, so reconnecting to a ledger you already know
 * updates it in place rather than accumulating near-duplicates -- including
 * when the token has been rotated, which is the common case.
 */
export async function rememberInstance(
  url: string,
  token: string,
  name?: string,
): Promise<Instance> {
  const normalised = normalizeUrl(url);
  const list = await listInstances();
  const existing = list.find((i) => normalizeUrl(i.url) === normalised);

  const instance: Instance = existing
    ? { ...existing, url: normalised, name: name?.trim() || existing.name }
    : {
        // Timestamp alone collides: two ledgers added in the same millisecond
        // got the same id, and forgetting one then deleted both. Caught by the
        // offline test, which creates them back to back.
        id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        url: normalised,
        name: name?.trim() || labelFromUrl(normalised),
      };

  const next = existing
    ? list.map((i) => (i.id === instance.id ? instance : i))
    : [...list, instance];

  await SecureStore.setItemAsync(tokenKeyFor(instance.id), token.trim());
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(next));
  await AsyncStorage.setItem(ACTIVE_KEY, instance.id);
  return instance;
}

/**
 * Point the app at a remembered ledger.
 *
 * Returns null when the token has gone -- SecureStore can be cleared
 * independently of AsyncStorage, so the list can outlive its credentials, and
 * silently connecting with nothing would look like a network fault.
 */
export async function activate(id: string): Promise<Instance | null> {
  const list = await listInstances();
  const instance = list.find((i) => i.id === id);
  if (!instance) return null;

  const token = await SecureStore.getItemAsync(tokenKeyFor(id));
  if (!token) return null;

  await saveCredentials(instance.url, token);
  await AsyncStorage.setItem(ACTIVE_KEY, id);
  return instance;
}

/**
 * Forget one. If it was active the app is left disconnected rather than
 * silently switched to another ledger -- writing to the wrong book because
 * something was deleted elsewhere is exactly the failure worth refusing.
 */
export async function forgetInstance(id: string): Promise<void> {
  const list = await listInstances();
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(list.filter((i) => i.id !== id)));
  await SecureStore.deleteItemAsync(tokenKeyFor(id));
  if ((await getActiveId()) === id) {
    await AsyncStorage.removeItem(ACTIVE_KEY);
    await clearCredentials();
  }
}

/**
 * Adopt credentials that predate this list.
 *
 * A phone connected before instances existed has a URL and token in
 * SecureStore but nothing in the list, so the switcher would show empty and
 * the feature would look broken on exactly the installs that need it most.
 * Called on Settings mount; a no-op once the ledger is known.
 */
export async function adoptCurrentCredentials(): Promise<Instance[]> {
  const list = await listInstances();
  const current = await loadCredentials();
  if (!current) return list;

  const normalised = normalizeUrl(current.url);
  if (list.some((i) => normalizeUrl(i.url) === normalised)) {
    // Known already, but make sure it is marked active -- otherwise nothing
    // in the list reads as "in use" and switching away looks impossible.
    if (!(await getActiveId())) {
      const found = list.find((i) => normalizeUrl(i.url) === normalised);
      if (found) await AsyncStorage.setItem(ACTIVE_KEY, found.id);
    }
    return list;
  }

  await rememberInstance(current.url, current.token);
  return listInstances();
}
