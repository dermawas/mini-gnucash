# Changelog

Notable changes to mini-gnucash. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A second scanner for when Gemini is busy or out of quota. The same pictures
  go to Claude Code on your own server, running on your own Claude
  subscription, reached over your VPN like the ledger. The server allows a
  small number a day, and the app says when Claude read a receipt and how many
  are left. Set it up under Settings, Receipt scanning. The service it talks to
  is a single small endpoint, described at the top of
  `src/services/receiptExtraction/claude.ts`.
- Notes for the scanner, in Settings. Rules only you know, such as which rides
  are for work, sent with every scan.

### Changed

- The scanner now picks the account for each item itself, from the list of
  accounts the entry can use. Before, it could only name a loose category,
  and the app guessed the account from matching words. A pick that does not
  name a real account, or is in the wrong currency, is ignored and the old
  matching takes over. Each scan now sends the names of those accounts, never
  a balance.
- The Accounts screen loads balances again by itself when the connection
  comes back. Before, if it first opened while the VPN was still coming up, it
  kept saying "Could not reach your ledger" under the list until you pulled
  down to refresh, even though the app was connected.
- Scanning takes several pictures of one receipt. A receipt too long for one
  screenshot can be photographed in pieces and picked together from the
  gallery, up to six at a time. The pieces usually overlap, so the scanner is
  told they are one receipt in reading order and that a figure appearing twice
  is the same money, not a second purchase.

### Not built yet

- Creating a new account from the phone.
- A place in an entry for a free item. The scanner reads a gift line at zero,
  and an entry cannot be saved while a row sits at zero, so the row has to be
  deleted by hand for now.

## [0.1.0] - 2026-09-16

First public release. Runs on a phone against a real GnuCash book.

### Added

**The server side**, as PostgreSQL functions reached over PostgREST:

- `mgc_ping`, which returns reachability, lock state and book mode in one round
  trip.
- Chart of accounts, balances, and the register for one account.
- `mgc_transfer`, which takes two numbers for a cross currency transfer and
  works out the rate itself, so there is no third number left to disagree.
  Checked against two rules before it commits.
- `mgc_record_entry`, which writes one entry with its items, any money back,
  and who paid, as a single multi split transaction.
- `mgc_set_split_cleared`, the only change made to any existing row.
- Wording completion from the book's own history, for descriptions
  (`mgc_descriptions`) and for line notes (`mgc_memos`).
- A recent entries list sorted on when things were keyed in, not on their
  dates.
- A permission model where the app's role holds no table privileges at all.
  Every read and write goes through a `SECURITY DEFINER` function.

**The app**, built with Expo and React Native:

- Browsing accounts and balances, each in its own currency.
- Entering expenses and income against real accounts.
- Receipt scanning with your own Google Gemini key, from the camera, a PDF
  invoice, or a saved screenshot.
- Multiple ledgers, so a clone and a real book can be switched between.
- The token kept in Android secure storage, never sent anywhere else.

### Known limits

- Never deletes, voids or edits an existing transaction. Corrections belong in
  GnuCash desktop.
- Writes cleared, never reconciled.
- No currency conversion for display, so there is no single net worth figure.
- Release builds are unsigned by a real keystore, so they install as a
  developer build.

[Unreleased]: https://github.com/dermawas/mini-gnucash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dermawas/mini-gnucash/releases/tag/v0.1.0
