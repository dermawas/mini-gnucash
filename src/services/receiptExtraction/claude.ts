// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

// Claude transport, for when Gemini is busy or out of quota.
//
// This does NOT call Anthropic's API, and it holds no Anthropic key. It calls a
// small service on your OWN server, which runs Claude Code under your own
// Claude subscription and hands back what it read. The phone reaches it the
// same way it reaches the ledger: over your VPN.
//
// The service is tiny, so here is all of it, for anyone building their own:
//
//   POST {url}/scan
//     Authorization: Bearer <token>
//     { "prompt": "<text>", "files": [{ "mimeType": "image/jpeg", "base64": "..." }] }
//
//   200  { "text": "<the model's reply>", "used": 3, "limit": 10, ... }
//   401  wrong token        429  the day's limit is used up
//   503  already reading one (or, from a proxy in front, not answering)
//   GET {url}/healthz  { "ok": true, "used": 3, "limit": 10, "model": "..." }
//
// The service adds nothing to the prompt except a one-line system prompt, so
// the instructions stay here in the app, where Gemini gets the very same ones.
// Claude has no response schema to enforce the shape the way Gemini's
// `responseSchema` does, so the schema goes into the text instead, and the
// reply is parsed defensively.

import { RESPONSE_SCHEMA } from './prompt';
import type { ClaudeQuota, RawExtraction, ScanImage } from './types';

/**
 * Longer than the service's own 90 s, so the service is the one to give up and
 * say why. A normal scan takes 5 to 12 s.
 */
const CLAUDE_FETCH_TIMEOUT_MS = 100_000;

/**
 * Why a Claude call failed, for code rather than for a person.
 *
 * Nothing here is retried: `limit` and `invalid_token` would fail the same way
 * again, and a second try at `busy` would only queue behind the first.
 */
export type ClaudeFailureKind = 'limit' | 'busy' | 'invalid_token' | 'unreachable' | 'other';

// A timeout is marked on the error, not read from `err.name`: see the same
// function in gemini.ts for why an abort cannot be recognised by its name here.
function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal })
    .catch((err) => {
      if (controller.signal.aborted) throw Object.assign(new Error('timed out'), { scanTimeout: true });
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

function serviceError(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string') return parsed.error;
  } catch {
    // not JSON: a proxy's HTML error page
  }
  return '';
}

/**
 * The first `{` to the last `}`. A model asked for bare JSON still sometimes
 * wraps it in a code fence or says a word first, and that should not cost a
 * scan that read the receipt perfectly well.
 */
function jsonIn(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export async function callClaude(
  server: { url: string; token: string },
  prompt: string,
  images: ScanImage[],
): Promise<
  | { ok: true; data: RawExtraction; quota: ClaudeQuota | null }
  | { ok: false; error: string; kind: ClaudeFailureKind }
> {
  const text = `${prompt}

Reply with ONLY one JSON object that matches this JSON schema. No code fence, no words before or after it.
${JSON.stringify(RESPONSE_SCHEMA)}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(`${server.url}/scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({ prompt: text, files: images }),
    });
  } catch (err: any) {
    return err?.scanTimeout || err?.name === 'AbortError'
      ? { ok: false, kind: 'unreachable', error: 'Claude on your server took too long. Try again, or enter it by hand.' }
      : { ok: false, kind: 'unreachable', error: "Couldn't reach Claude on your server. Are you on the VPN?" };
  }

  const body = await response.text();

  if (!response.ok) {
    const said = serviceError(body);
    switch (response.status) {
      case 401:
        return { ok: false, kind: 'invalid_token', error: 'Your server refused the Claude password. Check it in Settings.' };
      case 403:
        return { ok: false, kind: 'unreachable', error: 'Your server only takes scans over the VPN.' };
      case 429:
        return { ok: false, kind: 'limit', error: "Claude's scans for today are used up. Try again tomorrow, or enter it by hand." };
      case 413:
        return { ok: false, kind: 'other', error: 'Those pictures are too big for your server. Pick fewer.' };
      case 503:
        // The service says "busy" in its own JSON. A 503 without it is the
        // proxy in front, unable to reach the service at all.
        return /busy/i.test(said)
          ? { ok: false, kind: 'busy', error: 'Claude is reading another receipt. Try again in a moment.' }
          : { ok: false, kind: 'unreachable', error: 'The scan service on your server is not answering.' };
      case 400:
        return { ok: false, kind: 'other', error: `Your server refused the scan: ${said || 'bad request'}.` };
      default:
        return { ok: false, kind: 'other', error: "Claude couldn't read this receipt. Try again, or enter it by hand." };
    }
  }

  let reply: { text?: string; used?: number; limit?: number };
  try {
    reply = JSON.parse(body);
  } catch {
    return { ok: false, kind: 'other', error: 'Your server sent an answer this app could not read.' };
  }

  const quota: ClaudeQuota | null =
    typeof reply.used === 'number' && typeof reply.limit === 'number'
      ? { used: reply.used, limit: reply.limit }
      : null;

  try {
    const data = JSON.parse(jsonIn(reply.text ?? '')) as RawExtraction;
    if (!Array.isArray(data?.items)) throw new Error('no items');
    return { ok: true, data, quota };
  } catch {
    return { ok: false, kind: 'other', error: 'Could not parse AI response as JSON' };
  }
}
