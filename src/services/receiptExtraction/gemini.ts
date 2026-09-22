// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

// Gemini transport. Adapted from the retired Supabase Edge Function
// (supabase/functions/scan-receipt/index.ts) — same prompt, same schema,
// same 503 retry, same error mapping. Two things changed in the move from
// Deno to React Native:
//
//   1. The API key is now the *user's own*, passed in per call rather than
//      read from server-side secrets. See the note in ./index.ts on why that
//      does not violate this project's standing "no API key on the client"
//      rule.
//   2. An explicit timeout was added. The hosted path never needed one — an
//      Edge Function has its own execution ceiling — but on-device a stalled
//      request would otherwise hang the scan button indefinitely.

import { RESPONSE_SCHEMA } from './prompt';
import type { RawExtraction, ScanImage, TokenUsage } from './types';

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

// The models this app has actually been run against, and what was MEASURED on
// the device rather than what the docs claim. Offered as a list because the
// two names worth having are easy to mistype, and a typo here does not fail
// here -- it fails minutes later at the scan, as a 404, with a receipt in your
// hand.
//
// This list is NOT a closed set, and must never become one. Google renames and
// retires models; that is the entire reason the model is settable instead of
// compiled in. The picker keeps a free-text way in and `saveAiModel` still
// accepts any string. Adding an entry here is a convenience, never a gate.
//
// Deliberately absent: `gemini-2.5-flash` and `gemini-2.5-flash-lite`. Both
// are returned by ListModels and both answer 404 NOT_FOUND on
// :generateContent for this key. Listing them would offer a dead end wearing
// an official-looking name -- being in Google's list does not mean being
// callable.
export const KNOWN_GEMINI_MODELS: { id: string; note: string }[] = [
  {
    id: DEFAULT_GEMINI_MODEL,
    note: 'Extracts as well as the lite model, but slower: 12-14s on a receipt.',
  },
  {
    id: 'gemini-flash-lite-latest',
    note: 'Fastest and the most available under load: 3-4s. What got the first real receipt through.',
  },
];

// Deliberately far longer than src/services/api.ts's 8s. That budget is tuned
// for a LAN round-trip to PostgREST over the VPN, where failing fast is free.
// Vision inference over a photographed receipt legitimately runs 10-30s, so an
// aggressive timeout here would abort work that was about to succeed. This
// call also goes to the public internet rather than over the tunnel, which is
// the one place this app talks to anything that is not your own server.
const GEMINI_FETCH_TIMEOUT_MS = 60_000;

// Backoff for 503 / UNAVAILABLE. A single 1.5s retry was not enough: during a
// real spike on 2026-09-06, gemini-flash-latest returned 503 to both the first
// call and that retry, repeatedly, over several minutes -- while the very same
// request succeeded from a desktop moments later. The user saw "the AI scanner
// is busy" for something that would have gone through on a slightly later try.
// Two retries, the second much later, ride out a spike of that shape without
// making a failed scan feel hung.
const RETRY_DELAYS_MS = [1_500, 6_000];

// What a timeout and an unreachable Google say, named so scanReceipt.ts can
// tell the two apart when it explains why Claude read a receipt instead.
export const GEMINI_TIMEOUT_MESSAGE = 'The scan timed out. Please try again, or check your connection.';
export const GEMINI_UNREACHABLE_MESSAGE = "Couldn't reach the AI scanner. Please check your connection.";

// A timeout is marked on the error itself rather than read from `err.name`.
// On the S10 a fetch this timer aborted did NOT arrive as an AbortError: on
// 2026-09-22 a scan that ran into the 60 s limit said "Couldn't reach the AI
// scanner", which sent the reader to their connection when the truth was that
// Google was slow. Whether the timer fired is the one thing known for certain.
function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal })
    .catch((err) => {
      if (controller.signal.aborted) throw Object.assign(new Error('timed out'), { scanTimeout: true });
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

// Maps a Gemini error response to a short, user-facing message instead of
// dumping its raw JSON body (which is what the client used to show
// verbatim in an Alert — see GitHub issue #7).
//
// The key check is deliberately NOT keyed on the 400 status. Google reports a
// structurally invalid key as 400 / INVALID_ARGUMENT, which is the identical
// status and code a malformed *request* returns — a bad responseSchema, an
// unsupported generationConfig field. Only `details[].reason` (or the message
// text) tells them apart, so match on that.
//
// This mattered in practice: a PostgREST JWT was once pasted into the Gemini
// key field, and for three sessions the resulting 400 was read as evidence
// about the key itself rather than about what was being sent as one. Blaming
// the key on a bare 400 points the next person at the wrong thing.
type GeminiErrorBody = {
  error?: {
    status?: string;
    message?: string;
    details?: { reason?: string }[];
  };
};

/**
 * Why a call failed, for code rather than for a person.
 *
 * `friendlyGeminiError` below turns the same response into a sentence, which
 * is right for the screen and useless for deciding what to do next. Failing
 * over to another key must happen on `exhausted` and MUST NOT happen on
 * `invalid_key` -- walking the whole ring on a typo would burn every key's
 * quota to arrive at the same wrong answer three times over.
 */
export type GeminiFailureKind = 'exhausted' | 'invalid_key' | 'transient' | 'other';

export function geminiFailureKind(status: number, errText: string): GeminiFailureKind {
  let error: GeminiErrorBody['error'];
  try {
    error = (JSON.parse(errText) as GeminiErrorBody)?.error;
  } catch {
    // not JSON, fall through to the status-code-based mapping below
  }
  const parsedStatus = error?.status;

  if (status === 429 || parsedStatus === 'RESOURCE_EXHAUSTED') return 'exhausted';
  if (
    error?.details?.some((d) => d?.reason === 'API_KEY_INVALID') === true ||
    /api key not valid/i.test(error?.message ?? '') ||
    status === 401 ||
    status === 403 ||
    parsedStatus === 'PERMISSION_DENIED'
  ) {
    return 'invalid_key';
  }
  if (status === 503 || parsedStatus === 'UNAVAILABLE' || status >= 500) return 'transient';
  return 'other';
}

export function friendlyGeminiError(status: number, errText: string): string {
  let error: GeminiErrorBody['error'];
  try {
    error = (JSON.parse(errText) as GeminiErrorBody)?.error;
  } catch {
    // not JSON, fall through to the status-code-based mapping below
  }

  const parsedStatus = error?.status;
  const keyIsInvalid =
    error?.details?.some((d) => d?.reason === 'API_KEY_INVALID') === true ||
    /api key not valid/i.test(error?.message ?? '');

  if (keyIsInvalid) {
    return "Your Gemini API key was rejected. Check it in Receipt Scanning settings.";
  }
  if (status === 401 || status === 403 || parsedStatus === 'PERMISSION_DENIED') {
    return "Your Gemini API key isn't authorised. Check it in Receipt Scanning settings.";
  }
  if (status === 503 || parsedStatus === 'UNAVAILABLE') {
    return "The AI scanner is busy right now. Please try again in a moment.";
  }
  if (status === 429 || parsedStatus === 'RESOURCE_EXHAUSTED') {
    return "You've hit your Gemini rate limit or quota. Please try again shortly.";
  }
  if (status >= 500) {
    return "The AI scanner is temporarily unavailable. Please try again in a moment.";
  }
  // A 400 that is not about the key is the app's fault, not the user's. Say so,
  // so nobody re-enters a key that was fine.
  if (status === 400 || parsedStatus === 'INVALID_ARGUMENT') {
    return "The AI scanner rejected the request — that's a bug in this app, not your key. Enter this receipt manually for now.";
  }
  return "Couldn't read this receipt. Please try again or enter it manually.";
}

// The prompt comes FIRST and the pictures follow it in the order they were
// picked. Both halves of that matter. A model reading the instruction before
// the pictures knows it is looking at one receipt in pieces rather than at
// several receipts, and the order is the only thing telling it which piece is
// the top of the page -- the shots overlap, so content alone is ambiguous.
function fetchGemini(apiKey: string, model: string, prompt: string, images: ScanImage[]) {
  return fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              ...images.map((img) => ({
                inline_data: { mime_type: img.mimeType, data: img.base64 },
              })),
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    }
  );
}

export async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  images: ScanImage[]
): Promise<
  | { ok: true; data: RawExtraction; usage: TokenUsage | null }
  | { ok: false; error: string; kind: GeminiFailureKind }
> {
  let response: Response;
  try {
    response = await fetchGemini(apiKey, model, prompt, images);

    // Gemini's own 503 message says spikes are "usually temporary", and most
    // do clear without the user ever seeing an error. Give up only after the
    // whole ladder, not on the first disappointment.
    for (const delay of RETRY_DELAYS_MS) {
      if (response.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      response = await fetchGemini(apiKey, model, prompt, images);
    }
  } catch (err: any) {
    if (err?.scanTimeout || err?.name === 'AbortError') {
      return {
        ok: false,
        kind: 'transient',
        error: GEMINI_TIMEOUT_MESSAGE,
      };
    }
    return {
      ok: false,
      kind: 'transient',
      error: GEMINI_UNREACHABLE_MESSAGE,
    };
  }

  if (!response.ok) {
    const errText = await response.text();
    return {
      ok: false,
      kind: geminiFailureKind(response.status, errText),
      error: friendlyGeminiError(response.status, errText),
    };
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    return { ok: false, kind: 'other', error: 'No response from Gemini' };
  }

  const usage: TokenUsage | null = data?.usageMetadata
    ? {
        inputTokens: data.usageMetadata.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
      }
    : null;

  try {
    const parsed = JSON.parse(rawText) as RawExtraction;
    return { ok: true, data: parsed, usage };
  } catch {
    // Not a quota problem, so this must not fail over. Another key would
    // return the same unparseable answer.
    return { ok: false, kind: 'other', error: 'Could not parse AI response as JSON' };
  }
}
