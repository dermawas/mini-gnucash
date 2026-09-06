// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

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

import { EXTRACTION_PROMPT, RESPONSE_SCHEMA } from './prompt';
import type { RawExtraction, TokenUsage } from './types';

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

// Deliberately far longer than src/services/api.ts's 8s. That budget is tuned
// for a LAN round-trip to PostgREST over the VPN, where failing fast is free.
// Vision inference over a photographed receipt legitimately runs 10-30s, so an
// aggressive timeout here would abort work that was about to succeed. This
// call also goes to the public internet rather than over the tunnel, which is
// the one place this app talks to anything that is not your own server.
const GEMINI_FETCH_TIMEOUT_MS = 60_000;

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
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

function fetchGemini(apiKey: string, model: string, base64Image: string, mimeType: string) {
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
              { text: EXTRACTION_PROMPT },
              { inline_data: { mime_type: mimeType, data: base64Image } },
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
  base64Image: string,
  mimeType: string
): Promise<
  | { ok: true; data: RawExtraction; usage: TokenUsage | null }
  | { ok: false; error: string }
> {
  let response: Response;
  try {
    response = await fetchGemini(apiKey, model, base64Image, mimeType);

    // Gemini's own 503 message says spikes are "usually temporary" — a
    // single short retry resolves a meaningful share of these without
    // ever surfacing an error to the user at all.
    if (response.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      response = await fetchGemini(apiKey, model, base64Image, mimeType);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'The scan timed out. Please try again, or check your connection.' };
    }
    return { ok: false, error: "Couldn't reach the AI scanner. Please check your connection." };
  }

  if (!response.ok) {
    const errText = await response.text();
    return { ok: false, error: friendlyGeminiError(response.status, errText) };
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    return { ok: false, error: 'No response from Gemini' };
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
    return { ok: false, error: 'Could not parse AI response as JSON' };
  }
}
