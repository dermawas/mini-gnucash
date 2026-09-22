// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// The two scan settings that are not Gemini's: where Claude runs, and the
// owner's own notes for the scanner.
//
// CLAUDE ON YOUR OWN SERVER. When Gemini is busy or out of quota, a scan goes to
// a small service on the user's server that runs Claude Code on their own
// subscription (see receiptExtraction/claude.ts). Its address and token live in
// SecureStore, like the ledger's. The token is a secret and is only ever shown
// by its last four characters; the address is not, and is shown in full.
//
// THE NOTES are rules only the person keeping the book knows, such as "a Grab
// ride in Bandung is for Ego Eimi". They go with every scan, to Gemini and to
// Claude alike. Not a secret, so AsyncStorage rather than the keystore, and
// they are shown in full so they can be read before being changed.

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeUrl } from './api';
import { MAX_SCAN_NOTE } from './receiptExtraction';

const CLAUDE_URL = 'scan_claude_url';
const CLAUDE_TOKEN = 'scan_claude_token';
const SCAN_NOTE = 'mgc_scan_note';

export type ClaudeServer = { url: string; token: string };

/** Both halves, or null. One without the other cannot scan. */
export async function getClaudeServer(): Promise<ClaudeServer | null> {
  const [url, token] = await Promise.all([
    SecureStore.getItemAsync(CLAUDE_URL),
    SecureStore.getItemAsync(CLAUDE_TOKEN),
  ]);
  return url && token ? { url, token } : null;
}

export async function getClaudeUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(CLAUDE_URL);
}

/** The token's last four characters, for Settings to confirm which one is saved. */
export async function getClaudeTokenTail(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(CLAUDE_TOKEN);
  return token ? token.slice(-4) : null;
}

export async function saveClaudeUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(CLAUDE_URL, normalizeUrl(url));
}

export async function saveClaudeToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(CLAUDE_TOKEN, token.trim());
}

/** Turns the Claude fallback off. The notes are left alone. */
export async function clearClaudeServer(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(CLAUDE_URL),
    SecureStore.deleteItemAsync(CLAUDE_TOKEN),
  ]);
}

/**
 * Today's count from the server, for Settings. Spends no scan.
 *
 * Null when the server cannot be reached, which off the VPN is expected and
 * not an error.
 */
export async function getClaudeStatus(
  url: string,
): Promise<{ used: number; limit: number; model: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${url}/healthz`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.used === 'number' && typeof body?.limit === 'number'
      ? { used: body.used, limit: body.limit, model: String(body.model ?? '') }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getScanNote(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(SCAN_NOTE)) ?? '';
  } catch {
    return '';
  }
}

export async function saveScanNote(note: string): Promise<void> {
  const trimmed = note.trim().slice(0, MAX_SCAN_NOTE);
  if (trimmed) await AsyncStorage.setItem(SCAN_NOTE, trimmed);
  else await AsyncStorage.removeItem(SCAN_NOTE);
}
