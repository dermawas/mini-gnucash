// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// Photograph a receipt, or hand over a PDF, and turn it into rows the Entry
// screen can hold.
//
// The logic here was inside `app/scan/review.tsx`, where it could only ever
// serve that one screen. Lifting it out is what lets Scan become an INPUT
// METHOD rather than a destination: the same call fills the Entry screen,
// where the result can then have a money-back row added, be split across two
// funding accounts, or be corrected -- none of which the review screen could
// do.
//
// What it returns is a PROPOSAL, exactly as before. Nothing here reaches the
// ledger, no account is chosen without the user seeing it, and the matcher's
// basis travels with each line so the screen can say how much to trust it.
//
// A PDF goes down the same road as a photograph. Gemini takes a document as an
// inline part exactly as it takes an image, so the only thing that changes
// between the two is the mime type and where the bytes came from -- the
// allocation, the account matching and the merchant memory below cannot tell
// them apart and do not need to.

import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { extractReceipt, type ScanImage } from './receiptExtraction';
import { getAiModel } from './aiKey';
import { adoptLegacyKey, keysForScan, markExhausted, clearExhausted } from './aiKeys';
import { matchLine } from './accountMatch';
import { loadMemory, recall } from './merchantMemory';
import { roundingUnit } from '../utils/currency';
import type { Account } from './api';

/** Why an account was proposed, so the screen can say how firm it is. */
export type MatchBasis = 'tokens' | 'item' | 'merchant';

/**
 * Where the thing being scanned comes from.
 *
 * `camera` and `library` go through ImagePicker and are always images.
 * `library` is the only one that can return SEVERAL of them, which is how a
 * receipt too long for one screenshot gets scanned; see `pickImage`.
 * `document` goes through the system file picker and can be a PDF or an image
 * file -- a screenshot saved outside the gallery, an emailed invoice.
 */
export type ScanSource = 'camera' | 'library' | 'document';

export type ScannedLine = {
  name: string;
  amount: number;
  accountGuid: string | null;
  /** True while the account is the matcher's guess, not a user's choice. */
  proposed: boolean;
  basis: MatchBasis | null;
};

export type ScanOutcome =
  | { kind: 'cancelled' }
  | { kind: 'error'; title: string; message: string }
  /** A wallet topup is a transfer, not an expense. The caller redirects. */
  | { kind: 'topup'; message: string }
  | {
      kind: 'ok';
      merchant: string;
      date: string;
      sourceUri: string | null;
      lines: ScannedLine[];
      /**
       * The receipt's discount, as its own amount. It is NOT spread across the
       * lines any more -- see the note in receiptExtraction/index.ts about the
       * Bahagia Chinese Food entry, where spreading turned a 35.000 dish into
       * 19.091. The caller puts it in a money-back row.
       *
       * The ACCOUNT is deliberately not guessed. The model knows an amount came
       * off; it has no idea whether that belongs to a discount income account
       * or against the expense, and that choice has tax consequences the app
       * should not make silently.
       */
      discount: number;
      printedTotal: number;
      computedTotal: number;
      totalMismatch: boolean;
    };

// What Gemini will take as an inline part. A file outside this set is refused
// HERE rather than sent, because Google's answer to one is a 400, and
// `friendlyGeminiError` reads a 400 as a bug in this app -- which would point
// the next person at the code instead of at the file they picked.
const SCANNABLE_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

// Gemini's inline limit is about 20 MB for the WHOLE request, and base64 adds a
// third on top, so 6 MB of file sits well inside it. The tighter reason is the
// phone: `base64()` materialises the entire file as one JavaScript string, and
// the S10 has already had this app killed for memory with the camera open.
// For scale, a receipt photographed through ImagePicker at quality 0.7 is a
// few hundred KB, so nothing normal comes near this.
const MAX_SCAN_BYTES = 6 * 1024 * 1024;

// The ceiling above is now a ceiling on the WHOLE selection, not on each
// picture, because that is what both reasons were always about: Gemini's limit
// applies to the request, and the phone's memory to every base64 string alive
// at once. Six screenshots at quality 0.7 come to roughly 2 MB together, so
// this still turns nobody away in normal use.
//
// `selectionLimit` is the cheaper guard of the two and the only one that can
// stop a mistake BEFORE the memory is spent: a tap on "select all" in the
// gallery would otherwise decode a year of photographs to find out they were
// too big. Six is above the longest real receipt seen here (a Klik Indomaret
// order took three) with room to spare.
const MAX_SCAN_IMAGES = 6;

/** Picked pictures, ready to send, or why there is nothing to send. */
type PickResult =
  | {
      kind: 'picked';
      images: ScanImage[];
      /**
       * The FIRST picture's uri, not all of them. Nothing consumes this today
       * -- `entry.tsx` ignores it -- and when something does it will want one
       * thumbnail of the receipt, which is the top of the page.
       */
      uri: string | null;
    }
  | { kind: 'cancelled' }
  | { kind: 'error'; title: string; message: string };

/** Total decoded size of a selection, for the ceiling above. */
function decodedBytes(images: ScanImage[]): number {
  // base64 carries 3 bytes in every 4 characters, ignoring the padding, which
  // is near enough for a limit whose purpose is to catch an order of magnitude.
  return images.reduce((sum, img) => sum + Math.floor((img.base64.length * 3) / 4), 0);
}

/**
 * The camera or the gallery, through ImagePicker.
 *
 * The GALLERY takes several, the camera one. That asymmetry is deliberate and
 * not a gap to be closed later: a long receipt is screenshotted in pieces
 * before the app is ever opened, so the pieces are already sitting in the
 * gallery together and get picked in one go. Photographing a paper receipt in
 * pieces would mean re-opening the camera between shots, which ImagePicker
 * cannot do in one call anyway, and a paper receipt too long for one frame is
 * better dealt with by stepping back.
 */
async function pickImage(source: 'camera' | 'library'): Promise<PickResult> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      return {
        kind: 'error',
        title: 'Camera not allowed',
        message: 'Grant camera access to photograph a receipt.',
      };
    }
  }

  const picked =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.7 })
      : await ImagePicker.launchImageLibraryAsync({
          base64: true,
          quality: 0.7,
          allowsMultipleSelection: true,
          selectionLimit: MAX_SCAN_IMAGES,
        });

  if (picked.canceled || !picked.assets?.length) return { kind: 'cancelled' };

  // An asset with no base64 is unreadable, and dropping it silently would send
  // a receipt with a hole in the middle -- which scans perfectly well and
  // produces a total nobody can explain. Refuse the whole selection instead.
  if (picked.assets.some((a) => !a.base64)) {
    return {
      kind: 'error',
      title: 'Could not read that image',
      message:
        picked.assets.length > 1
          ? 'One of those pictures could not be read. Try again, or pick a different set.'
          : 'Try again, or pick a different photo.',
    };
  }

  const images: ScanImage[] = picked.assets.map((a) => ({
    base64: a.base64 as string,
    mimeType: a.mimeType ?? 'image/jpeg',
  }));

  const total = decodedBytes(images);
  if (total > MAX_SCAN_BYTES) {
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
    return {
      kind: 'error',
      title: images.length > 1 ? 'Those pictures are too big to scan' : 'That picture is too big to scan',
      message: `They come to ${mb(total)} MB and the limit is ${mb(MAX_SCAN_BYTES)} MB. Pick fewer, or just the parts of the receipt with the items and the total on them.`,
    };
  }

  return {
    kind: 'picked',
    images,
    uri: picked.assets[0].uri ?? null,
  };
}

/**
 * A PDF or an image file, through the system file picker.
 *
 * This needed no new dependency and no new build: `expo-file-system` is already
 * here as a dependency of `expo` itself, and it carries both the picker and a
 * base64 reader. Nothing native was added, so the release build already on the
 * phone can run it.
 *
 * On Android the picker is `ACTION_OPEN_DOCUMENT`, so what comes back is a
 * `content://` URI from the Storage Access Framework. That is why the mime type
 * is read from `file.type`, which resolves through the content provider, and
 * NEVER from the file name: a SAF URI's last path segment is an opaque document
 * id like `msf:1234`, with no extension in it to read. `file.extension` and
 * `file.name` are both derived from that path and are junk here.
 *
 * Unlike the camera path there is no re-encoding, so a PDF and a screenshot both
 * go up at full fidelity. That is better for reading small print and is the
 * reason a size ceiling is needed at all.
 */
async function pickDocument(): Promise<PickResult> {
  // `pickFileAsync` reports EVERY failure as `canceled: true` -- read its catch
  // block, it swallows the error. So a picker that could not open at all is
  // indistinguishable here from a user backing out, and both end up doing
  // nothing, which is the only safe reading of the two. The try/catch below is
  // belt and braces for a future version that throws instead.
  let file: File;
  try {
    const result = await File.pickFileAsync({ mimeTypes: ['application/pdf', 'image/*'] });
    if (result.canceled || !result.result) return { kind: 'cancelled' };
    file = result.result;
  } catch {
    return {
      kind: 'error',
      title: 'Could not open the file picker',
      message: 'Try again, or photograph the receipt instead.',
    };
  }

  const mimeType = (file.type ?? '').toLowerCase();
  if (!SCANNABLE_MIME.includes(mimeType)) {
    return {
      kind: 'error',
      title: 'That kind of file cannot be scanned',
      message: mimeType
        ? `The scanner takes a PDF or an image. That file is ${mimeType}.`
        : 'The scanner takes a PDF or an image, and Android would not say what that file is.',
    };
  }

  // `size` is 0 when the provider will not say, so only the CEILING is
  // enforced. Refusing a file whose size could not be read would turn away a
  // perfectly scannable receipt for a reason that has nothing to do with it.
  const size = file.size ?? 0;
  if (size > MAX_SCAN_BYTES) {
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
    return {
      kind: 'error',
      title: 'That file is too big to scan',
      message: `It is ${mb(size)} MB and the limit is ${mb(MAX_SCAN_BYTES)} MB. A single page, photographed or exported normally, is a small fraction of that.`,
    };
  }

  let base64: string;
  try {
    base64 = await file.base64();
  } catch {
    return {
      kind: 'error',
      title: 'Could not read that file',
      message: 'Android would not hand the file over. Try saving it to the phone first, or photograph it instead.',
    };
  }
  if (!base64) {
    return {
      kind: 'error',
      title: 'That file is empty',
      message: 'There was nothing in it to read.',
    };
  }

  // One file, even though the shape now carries a list. `pickFileAsync` has no
  // multiple-selection option, and a PDF does not need one: its own pages are
  // already read as a single receipt by the prompt.
  return { kind: 'picked', images: [{ base64, mimeType }], uri: file.uri };
}

export async function scanReceipt(params: {
  source: ScanSource;
  /** The funding account's currency; decides which expenses can be matched. */
  currency: string | null;
  scu?: number;
  /** Postable expense accounts, already filtered by the caller. */
  candidates: Account[];
}): Promise<ScanOutcome> {
  const { source, currency, scu, candidates } = params;

  // Folds a key saved before the key list existed into it. A no-op afterwards.
  await adoptLegacyKey();
  const keys = await keysForScan();
  if (keys.length === 0) {
    return {
      kind: 'error',
      title: 'No Gemini key',
      message: 'Receipt scanning uses your own Gemini API key. Add one in Settings.',
    };
  }

  // Cancelling and every refusal are already ScanOutcome shapes, so they pass
  // straight through.
  const picked = source === 'document' ? await pickDocument() : await pickImage(source);
  if (picked.kind !== 'picked') return picked;

  // Walk the keys. `keysForScan` has already put them in round-robin order and
  // moved the cursor on, so this loop only decides when to give up.
  //
  // Only an `exhausted` failure moves to the next key. Anything else -- a bad
  // key, a malformed request, no connection -- would fail identically on all
  // of them, and trying anyway would spend the other keys' quota to arrive at
  // the same answer three times over.
  const model = await getAiModel();
  const unit = roundingUnit(currency ?? 'IDR', scu);

  let result: Awaited<ReturnType<typeof extractReceipt>> | null = null;
  let exhausted = 0;

  for (const key of keys) {
    result = await extractReceipt({
      images: picked.images,
      apiKey: key.secret,
      model,
      roundingUnit: unit,
    });

    if (result.ok) {
      // A success is the only thing that clears the Settings flag. It has to
      // be a real one: a key that answered is demonstrably back, whereas a
      // cooldown elapsing proves nothing.
      await clearExhausted(key.id);
      break;
    }
    if (result.kind === 'exhausted') {
      await markExhausted(key.id);
      exhausted += 1;
      continue;
    }
    break;
  }

  if (!result || !result.ok) {
    // When every key is out, say that rather than repeating a message written
    // for one key. "Try again shortly" is misleading advice when the answer is
    // that all of them are spent.
    const message =
      exhausted > 0 && exhausted === keys.length
        ? keys.length === 1
          ? "Your Gemini key has hit its rate limit or quota. Try again shortly, or add another key in Settings."
          : `All ${keys.length} of your Gemini keys have hit their limits. Try again shortly. If they ran out together, they may share one Google project's quota.`
        : (result?.message ?? "Couldn't read that receipt.");
    return { kind: 'error', title: 'Could not read that receipt', message };
  }

  // A topup moves money between two of the user's own accounts. Recording it
  // as an expense against a category is the wrong shape and would invent a
  // rate, so it is reported rather than guessed at.
  if (result.receipt_type === 'topup') {
    return {
      kind: 'topup',
      message:
        'Money moving into your own wallet is a transfer, not an expense. Switch this entry to Move: it takes both amounts and derives the rate itself.',
    };
  }

  // A purchase with no lines is not a shape this screen can hold, and it is
  // how a STATEMENT arrives: the prompt asks for an empty array when a document
  // lists several separate transactions rather than one purchase. A receipt
  // whose lines simply could not be read arrives identically, so the message
  // names both rather than claiming to know which one it was.
  //
  // The alternative -- filling in the merchant, the date and a closing balance
  // with no rows under them -- looks like a scan that half worked, on an entry
  // that cannot be committed.
  if (result.items.length === 0) {
    return {
      kind: 'error',
      title: 'No lines came back',
      message:
        'Nothing on that was read as a line item. If it is a statement listing several transactions, this app records one receipt at a time and the rest belong in GnuCash desktop. Otherwise try a sharper photo, or enter it by hand.',
    };
  }

  const memory = await loadMemory();
  const lines: ScannedLine[] = result.items.map((item) => {
    const match = matchLine(
      item,
      candidates,
      currency,
      recall(memory, result.merchant ?? '', item.name),
    );
    return {
      name: item.name,
      amount: item.allocated_price,
      accountGuid: match?.account.guid ?? null,
      proposed: !!match,
      basis: (match?.basis as MatchBasis | undefined) ?? null,
    };
  });

  return {
    kind: 'ok',
    merchant: result.merchant ?? '',
    date: result.date,
    sourceUri: picked.uri,
    lines,
    discount: result.receipt_discount,
    printedTotal: result.printed_total,
    computedTotal: result.computed_total,
    totalMismatch: result.total_mismatch,
  };
}
