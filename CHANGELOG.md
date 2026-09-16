# Changelog

Notable changes to mini-gnucash. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Not built yet

- Creating a new account from the phone.

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
