// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

// Storage for the user's own Gemini API key.
//
// SecureStore only. This key is NEVER mirrored anywhere — not to the GnuCash
// book, not to a settings table, nowhere. There is no server of ours to mirror
// it to, and the book is a ledger, not a keyring.
//
// It is also never written to this repository. The repo is public from its
// first commit and scripts/check-no-secrets.sh fails closed on anything that
// looks like a credential in the working tree. A key belongs on the device,
// typed into Settings, and nowhere else.
//
// One profile per device, so a fixed key name is correct. It still lives
// behind a named constant rather than a scattered string literal, so if a
// profile concept ever arrives there is one place to scope it.

import * as SecureStore from 'expo-secure-store';
import { DEFAULT_GEMINI_MODEL } from './receiptExtraction';

const AI_API_KEY = 'ai_gemini_api_key';
const AI_MODEL = 'ai_gemini_model';

export async function getAiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(AI_API_KEY);
}

export async function getAiModel(): Promise<string> {
  const stored = await SecureStore.getItemAsync(AI_MODEL);
  return stored?.trim() || DEFAULT_GEMINI_MODEL;
}

export async function saveAiKey(apiKey: string, model?: string): Promise<void> {
  await SecureStore.setItemAsync(AI_API_KEY, apiKey.trim());
  const trimmedModel = model?.trim();
  if (trimmedModel) {
    await SecureStore.setItemAsync(AI_MODEL, trimmedModel);
  }
}

// Saved separately from the key, because the reason to change it -- a model
// that is overloaded, renamed or retired -- has nothing to do with the key
// being wrong. An empty string clears the override and falls back to
// DEFAULT_GEMINI_MODEL, so there is always a way back to the shipped default
// without reinstalling.
export async function saveAiModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (trimmed) {
    await SecureStore.setItemAsync(AI_MODEL, trimmed);
  } else {
    await SecureStore.deleteItemAsync(AI_MODEL);
  }
}

export async function clearAiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(AI_API_KEY);
  await SecureStore.deleteItemAsync(AI_MODEL);
}

/**
 * Remove only the key, leaving the model override alone.
 *
 * For `aiKeys.ts`'s migration, which copies this entry into the key list and
 * then clears it. `clearAiKey` above would take the model with it, silently
 * resetting a deliberate choice of model as a side effect of a storage change
 * the user never asked for.
 */
export async function clearLegacyAiKeyOnly(): Promise<void> {
  await SecureStore.deleteItemAsync(AI_API_KEY);
}

export async function hasAiKey(): Promise<boolean> {
  return !!(await getAiKey());
}

// Shows only the last 4 characters, so Settings can confirm which key is saved
// without ever redisplaying it in full.
export function maskKey(apiKey: string): string {
  if (apiKey.length <= 4) return '••••';
  return `••••••••${apiKey.slice(-4)}`;
}
