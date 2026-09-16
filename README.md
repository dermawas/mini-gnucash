# mini-gnucash

An Android app that writes straight into a **GnuCash book stored in
PostgreSQL**, over your own private network.

There is no account to make, no server of ours, no cloud, and no copy of your
data anywhere. GnuCash is the only ledger. A wallet is a `BANK` account and a
category is an `EXPENSE` account, so there is nothing to map and nothing that
can fall out of step.

> **Status: working, but young.** Six of eight planned pieces are done. It runs
> on a Galaxy S10 against a real 400 account book, browses balances, and records
> scanned receipts as multi split transactions. Creating new accounts from the
> phone is not written yet. Read [What it will not do](#what-it-will-not-do)
> before you decide it suits you.

## What it does

- Browse your chart of accounts and your balances
- Enter expenses and income against real accounts
- Cross currency transfers that cannot go out of balance
  ([why that is hard](#the-transfer-problem-this-exists-to-solve))
- Photograph a receipt, and have it propose accounts and amounts for you to
  confirm, using your own Google Gemini key
- Do the same with a PDF invoice or a saved screenshot, from a file picker
- Complete a description or a line note from wording your book has used before
- Mark splits cleared

## What it will not do

This list is on purpose, not a backlog.

- **Delete, void or edit an existing transaction.** Corrections belong in
  GnuCash desktop. The only change it makes to an existing row is toggling a
  split between not cleared and cleared.
- **Reconcile.** It writes `c` for cleared, never `y` for reconciled. Real
  reconciliation needs a statement balance and belongs on the desktop.
- **Convert currencies for display.** Every balance is shown in its own
  account's currency. There is no single net worth figure, because that would
  need exchange rates the app does not have.

## How the pieces fit

```
  Android phone                your own server
  +---------------+            +----------------------------------+
  |  mini-gnucash |            |  PostgREST                       |
  |               |---- VPN -->|    connects as authenticator_mgc |
  |  holds a JWT  |            |    switches to gnucash_mgc_user  |
  +---------------+            |             |                    |
                               |             v                    |
                               |  PostgreSQL                      |
                               |    mgc_* functions               |
                               |    your GnuCash book             |
                               +----------------------------------+
```

The phone speaks HTTP to PostgREST. PostgREST calls a small set of PostgreSQL
functions, all named `mgc_*`. Those functions are the only way in. See
[Security model](#security-model).

## Before you start

You need all of these.

1. **A GnuCash book already stored in PostgreSQL.** Not a `.gnucash` file. If
   yours is still a file, open it in GnuCash desktop and use *File, Save As*
   with PostgreSQL as the format. Do that first and come back.
2. **PostgreSQL 13 or newer.** Version 13 is where `gen_random_uuid()` arrives
   in core, and nothing here needs an extension.
3. **A Linux machine you control** to run PostgREST. It can be the same machine
   as PostgreSQL.
4. **A VPN**, such as WireGuard, that your phone can join. See
   [Step 6](#step-6-put-postgrest-behind-a-vpn) for why this is not optional.
5. **An Android phone**, plus Node.js and the Android SDK on your computer to
   build the app.
6. **Optional: a Google Gemini API key**, only if you want receipt scanning. The
   app works fine without one.

Set aside an hour or two for the first run through.

---

# Setting it up

## Step 1: Make a clone, and use the clone

Do not point anything at your real book yet. Make a copy and work on that until
you trust it.

```bash
sudo -u postgres createdb gnucash_clone
sudo -u postgres pg_dump gnucash | sudo -u postgres psql -d gnucash_clone
sudo -u postgres psql -d gnucash_clone -c "DELETE FROM gnclock;"
```

Replace `gnucash` with your own database name.

**That last line matters.** A dump can carry a stale desktop lock row across
with it. If you leave it there, every write will refuse and the reason will not
be obvious.

## Step 2: Look at your book before you change it

```bash
sudo -u postgres psql -d gnucash_clone -f sql/00_verify.sql
```

This reads. It changes nothing. Read the output.

**This step is not optional, and skipping it is the likeliest way to have a bad
time.** Books genuinely differ from one another, and the differences are silent
rather than loud. It tells you three things the rest depends on:

- whether your book uses trading accounts
- what your `accounts` table's defaults are
- what `commodity_scu` each of your currencies uses, which is how many decimal
  places each one really has

Guess any of those wrong and you get numbers that look plausible and are wrong.

## Step 3: Create the roles

**Run this as the `postgres` superuser.** Not as `gnucash_owner`.

```bash
sudo -u postgres psql -d gnucash_clone -f sql/10_roles_and_grants.sql
```

That is not a style preference. `gnucash_owner` does not hold grant option on
the GnuCash tables, so a `GRANT` issued as `gnucash_owner` silently does nothing
and still reports success. You would believe the grants applied, and find out
much later from an error inside a function.

The file prints three checks at the end. **Read them.** That is where you find
out if this happened to you.

It creates three roles.

| Role | What it is |
|---|---|
| `gnucash_owner` | Owns the functions and holds the real table privileges. Also the role GnuCash desktop connects as. |
| `gnucash_mgc_user` | What the phone becomes. Has **no table privileges at all**. |
| `authenticator_mgc` | The only role PostgREST logs in as. Owns nothing, and can only switch into `gnucash_mgc_user`. |

Two of them are created with a `CHANGE_ME` placeholder password. **Change both
now**, before you go any further:

```sql
ALTER ROLE gnucash_owner     PASSWORD 'your own password here';
ALTER ROLE authenticator_mgc PASSWORD 'a different password here';
```

You can rename all three roles if you want. Just keep the names consistent with
your PostgREST config and your token.

## Step 4: Install the functions

Run these **in order**, as the `postgres` superuser, against the same database.

```bash
for f in sql/20_helpers.sql sql/30_read_rpcs.sql sql/35_ledger_reads.sql \
         sql/36_recent_entries.sql sql/37_descriptions.sql sql/38_memos.sql \
         sql/40_transfer.sql sql/46_record_entry.sql sql/50_set_split_cleared.sql; do
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d gnucash_clone -f "$f" || break
done
```

What each one is for:

| File | What it adds |
|---|---|
| `20_helpers.sql` | GUIDs, neutral timestamps, the lock check, trading account lookup |
| `30_read_rpcs.sql` | `mgc_ping`, and the chart of accounts |
| `35_ledger_reads.sql` | Balances and the register |
| `36_recent_entries.sql` | What was keyed in lately, across the whole book |
| `37_descriptions.sql` | Wording used before, to complete a description |
| `38_memos.sql` | Notes used before, to complete a line's note |
| `40_transfer.sql` | Transfers, including cross currency |
| `46_record_entry.sql` | One entry: its items, money back, and who paid |
| `50_set_split_cleared.sql` | The cleared flag |

Each file grants `EXECUTE` on its own functions at the end, so a function and
its permission can never drift apart.

## Step 5: Install and configure PostgREST

Download PostgREST from
[its releases page](https://github.com/PostgREST/postgrest/releases) and put the
binary at `/usr/local/bin/postgrest`.

```bash
sudo mkdir -p /etc/postgrest
sudo cp postgrest/postgrest.conf.example /etc/postgrest/postgrest.conf
sudo chmod 600 /etc/postgrest/postgrest.conf
sudo nano /etc/postgrest/postgrest.conf
```

Every value marked `CHANGE_ME` has to be filled in. Generate the JWT secret
with:

```bash
openssl rand -base64 32
```

Do the `chmod 600` at the time rather than later. That file holds a database
password and a signing secret, and a world readable copy of it is as bad as it
sounds.

Then run it as a service:

```bash
sudo cp postgrest/postgrest.service.example /etc/systemd/system/postgrest.service
sudo nano /etc/systemd/system/postgrest.service   # set User=
sudo systemctl daemon-reload
sudo systemctl enable --now postgrest
sudo systemctl status postgrest
```

## Step 6: Put PostgREST behind a VPN

**PostgREST speaks plain HTTP, and your token is a bearer credential.** Anyone
who can reach the port and has the token is in. Do not bind it to a public
address.

Pick one of these:

- **Bind it to a VPN interface address**, for example a WireGuard `10.x.x.x`.
  That is what `server-host` in the config is for, and it is what this project
  does. A leaked token is then useless to anyone who cannot first get onto your
  network.
- **Bind it to `127.0.0.1`** and put a reverse proxy with TLS in front, if you
  need to reach it without a VPN.

Check what is actually listening before you trust it:

```bash
sudo ss -lntp | grep postgrest
```

If that shows `0.0.0.0`, your `server-host` did not take effect. Fix it before
you go on.

## Step 7: Make a token

```bash
python3 scripts/make_jwt.py "the jwt-secret from your postgrest.conf" gnucash_mgc_user
```

The secret has to match `jwt-secret` in `postgrest.conf` exactly. The script
uses only the Python standard library, so a bare server can run it.

Test it end to end from the server:

```bash
curl -s -X POST http://YOUR_VPN_IP:3000/rpc/mgc_ping \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

You should get JSON back describing the book. If you get a `404`, see
[When something does not work](#when-something-does-not-work).

**This token never expires.** That is a deliberate choice for a single user
setup, not an oversight. Treat it exactly like a password.

## Step 8: Build the app

```bash
npm install
npx expo prebuild
cd android
SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew assembleRelease
```

The APK lands in `android/app/build/outputs/apk/release/`.

**Build the release variant, not debug.** A debug APK contains no JavaScript at
all. It downloads the bundle from your development server every time it starts,
so the phone stops working the moment it is away from your computer. Worse, it
does not fail with an error, it just hangs on the splash screen.

Size tells them apart, and so does looking inside:

```bash
unzip -l android/app/build/outputs/apk/release/app-release.apk | grep index.android.bundle
```

A release APK has that line. A debug one has no bundle at all. Size is a rough
second check: on version 0.1.0 the release APK is about 46 MB and the debug one
about 80 MB. Sizes move between versions, so trust the bundle check rather than
the number.

Then install it:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

## Step 9: Connect the phone

Join the phone to your VPN, open the app, and fill in the Connect screen.

- **Name this ledger**, anything you like. It only labels the connection so you
  can tell two apart.
- **PostgREST URL**, for example `http://10.8.0.1:3000`
- **JWT token**, the one from step 7

Tap **Test connection** before you save. The token is kept in Android's secure
storage and never leaves the phone.

## Step 10: Move to your real book

Once you have entered a few transactions on the clone and checked them in
GnuCash desktop, repeat steps 3, 4 and 5 against your real database.

Use a **separate PostgREST instance on a separate port**, with **its own
password and its own signing secret**. If you share the secret between the two,
a token for your clone will also open your real book.

---

## Security model

The phone holds a JWT naming a PostgreSQL role. That role has **zero table
privileges**. It cannot `SELECT` a single row of anything. Every read and every
write goes through a `SECURITY DEFINER` function, which means the whole
permission boundary is one list of function grants that you can read in a single
query.

That is stricter than tidiness needs, and the reason is specific.

**GnuCash desktop reads the `versions` table first when it opens a book. If it
cannot read that table, it decides the database is empty and tries to create a
fresh book in it.** A role with *partial* access is the dangerous shape, because
it can get far enough into that sequence to matter. A role with no table
privileges at all fails desktop's very first read cleanly and stops there.

That was a real near miss on this project's own server, which is why it is
written down.

## The transfer problem this exists to solve

Entering a cross currency transfer by hand asks you for three numbers: the
amount out, the amount in, and the rate. Only two of them are independent.
Rounding makes them disagree, and the difference lands in `Imbalance-USD`.

The function here takes **two** numbers and works out the rate itself. There is
no third number left to disagree. Before it commits, the splits are checked
against two rules:

1. The values sum to zero.
2. Each currency's quantities independently sum to zero.

If either check fails, nothing is written.

## When something does not work

**A `404` on an `/rpc/mgc_...` call, but the function exists in the database.**
PostgREST caches the schema. Every SQL file here ends with
`NOTIFY pgrst, 'reload schema';` and on some setups that is not enough. Send the
signal directly:

```bash
sudo systemctl kill -s SIGUSR1 postgrest
```

**`permission denied for sequence slots_id_seq`.** The table grant on its own is
not enough, PostgreSQL needs the sequence too. Run `sql/10_roles_and_grants.sql`
again as the `postgres` superuser, and read the checks it prints.

**Every write refuses and reads are fine.** Your book has a lock row. Either
GnuCash desktop has the book open, or a dump carried a stale one across. Close
the desktop, or `DELETE FROM gnclock;` if you are sure nothing else is using it.

**`WARNING: no privileges were granted`.** You ran the roles file as
`gnucash_owner` instead of `postgres`, so nothing applied. Run it again as
`postgres`.

**The app hangs on the splash screen.** You installed a debug APK. See
[Step 8](#step-8-build-the-app).

**Amounts are wrong in the last decimal place.** Check the `commodity_scu`
output from `sql/00_verify.sql` against what you expected.

## Licence

GPLv3. See [LICENSE](LICENSE) for the full text.

Portions derived from [Ledgerize](https://github.com/dermawas/ledgerize)
(© 2026 Forstra Digital), also GPLv3. Specifically the PostgREST bridge, the
receipt extraction module, and the double entry conventions.

GnuCash is a separate project and is not affiliated with this one.

---

Built by [Dermawan](https://dermawan.net). Notes and other work at
[Flowform Lab](https://flowformlab.com).
