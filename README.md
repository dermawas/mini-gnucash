# mini-gnucash

A phone client that talks **directly to a GnuCash PostgreSQL book** over a
private network, via PostgREST. No second copy of your data, no accounts, no
server of ours, no sync.

> **Status: running on a phone, against a clone — never yet against a real
> book.** The server side is built and verified; the app is installed on a
> Galaxy S10 and has browsed real balances and recorded scanned receipts as
> multi-split transactions on a clone of a 400-account book. Six of eight
> increments are done — account creation is not written yet, and **nothing has
> been written to a production book.** The name is a placeholder.

GnuCash is the only ledger. There is no local database on the phone, so there is
nothing to fall out of step and no "mapping" step — a wallet *is* a `BANK`
account, a category *is* an `EXPENSE` account.

## What it will do

- Browse your chart of accounts and balances
- Enter expenses and income against real accounts
- **Cross-currency transfers that cannot go out of balance** (see below)
- Scan a receipt with your own Gemini key, propose accounts, you confirm
- Scan a PDF invoice or a saved screenshot, the same way, from a file picker
- Mark splits cleared

## What it deliberately will not do

- **Delete, void or edit an existing transaction.** Corrections belong in
  GnuCash desktop. The phone's only mutation of an existing row is toggling a
  split between not-cleared and cleared.
- **Reconcile.** It writes `'c'` (cleared), never `'y'` (reconciled). Real
  reconciliation needs a statement balance and belongs on the desktop.
- **Convert currencies for display.** Balances are shown in each account's own
  commodity. There is no net-worth figure, because that would need exchange
  rates the app does not have.

## The transfer problem this exists to solve

Entering a cross-currency transfer by hand asks you for three numbers — amount
out, amount in, and the rate — of which only two are independent. Rounding makes
them disagree and the difference lands in `Imbalance-USD`.

The RPC here takes **two** numbers and derives the rate. There is no third
number to disagree, and the split construction is checked against two invariants
before it commits: values sum to zero, and each commodity's quantities
independently sum to zero.

## Security model

The phone holds a JWT naming a Postgres role. That role has **zero table
privileges** — it cannot `SELECT` a single row of anything. Every read and write
goes through a `SECURITY DEFINER` function, so the entire permission boundary is
one list of function grants.

That is stricter than it needs to be for tidiness, and the reason is specific:
GnuCash desktop reads the `versions` table first when opening a book, and if it
cannot, it concludes the database is empty and tries to initialise a fresh one.
A role with *partial* access is the dangerous shape. A role with none fails
desktop's first read cleanly.

PostgREST should be bound to a VPN-only interface. Even a leaked token is then
useless to anyone who cannot first reach your network.

## Setup

Run these against your own book, as the `postgres` superuser, **in order**:

```
sql/00_verify.sql            read-only; answers questions the rest depends on
sql/10_roles_and_grants.sql  roles, and the owner-side grants
sql/20_helpers.sql           guid, neutral timestamp, lock check, trading lookup
sql/30_read_rpcs.sql         ping, chart of accounts
sql/35_ledger_reads.sql      balances, register
sql/40_transfer.sql          transfers, including cross-currency
sql/45_record_transaction.sql  expenses and income
sql/50_set_split_cleared.sql   the cleared flag
```

`00_verify.sql` is not optional reading. Several decisions — whether your book
uses trading accounts, what your accounts table's defaults are, what
`commodity_scu` your currencies use — differ between books, and guessing them
wrong is silent rather than loud.

**Develop against a clone first**, never your real book:

```bash
sudo -u postgres createdb gnucash_clone
sudo -u postgres pg_dump gnucash | sudo -u postgres psql -d gnucash_clone
sudo -u postgres psql -d gnucash_clone -c "DELETE FROM gnclock;"
```

That last line matters — a dump can carry a stale desktop lock row, which would
make every write refuse.

## Licence

GPLv3. Portions derived from
[Ledgerize](https://github.com/dermawas/ledgerize) (© 2026 Forstra Digital),
also GPLv3 — specifically the PostgREST bridge, the receipt-extraction module,
and the double-entry conventions.
