# LedgerLine

LedgerLine is a small money-movement demo built around one rule: a movement must either post completely as balanced debits and credits, or not change a balance at all. It includes a dashboard, account statements, three roles, an append-only posting history, request idempotency, and automated HTTP tests that race two separate server processes against the same SQLite database.

## Run it on Windows

1. Install Node.js 22.13 or newer.
2. Open the `LedgerLine` folder in VS Code.
3. Open **Terminal → New Terminal** and run:

   ```powershell
   npm start
   ```

4. Open **http://localhost:3000** in a browser.
5. Sign in with one of the local demo accounts below.

No `npm install` is needed; the project uses Node built-ins. The first run creates `data\ledgerline.sqlite` and seeds local demo data. To configure local environment variables, copy `.env.example` to `.env`; `npm start` loads it. Keep `.env` out of Git and do not use the demo settings on a public deployment. Node may show an experimental warning for `node:sqlite`; this is the built-in SQLite module supplied by Node.js.

### Local demo accounts

| Role | Username | Password |
|---|---|---|
| Administrator | `admin` | `AdminDemo!2026` |
| Account holder | `maya` | `MayaDemo!2026` |
| Account holder | `isha` | `IshaDemo!2026` |
| Read-only auditor | `auditor` | `AuditDemo!2026` |

These are **demo-only credentials**. Do not expose a server seeded with them to the public internet. The local demo starts with two customer accounts and one internal external-clearing account.

To stop the server, focus its terminal and press **Ctrl+C**. Start it again with `npm start`; the SQLite data persists.

## What is implemented

- Account dashboard with rupee balances and per-account running statements.
- Create accounts with a zero balance; administrators can assign an account to an account holder.
- Administrator-created account-holder and auditor users.
- Deposits, withdrawals, and internal transfers, using integer paise rather than floating-point money.
- Double-entry postings to an internal clearing account for external deposits and withdrawals.
- Database-enforced nonnegative customer balances and a SQLite `BEGIN IMMEDIATE` transaction around every movement.
- A request key per authenticated user. Exact retries return the stored result; a key reused with a different payload is rejected.
- A durable record for posted and refused movement requests; refused attempts against an identified account appear in its statement with the unchanged balance.
- API-level role and account-ownership checks; CSRF tokens on state-changing authenticated requests.
- Append-only database triggers for postings, movement records, replay records, and audit events.
- Tests that issue simultaneous withdrawals to two separate server processes, exercise retries, check account authorization, and verify posting invariants.

## Integrity model

Amounts are positive integer paise at the API boundary. Each posted movement has two ledger postings:

- Transfer: debit the source and credit the destination by the same amount.
- Deposit: credit the customer and debit the system clearing account.
- Withdrawal: debit the customer and credit the system clearing account.

The sum of credits minus debits for all posted ledger entries is zero. Customer account balances are cached for reads but updated in the same SQLite transaction as their postings. The transaction starts with `BEGIN IMMEDIATE`, which obtains SQLite's write reservation before checking the source balance. That serializes competing writers, including the two-process test. A database trigger independently refuses a customer-balance update below zero. If any posting fails, the transaction rolls back.

The external clearing account may have a negative balance because it represents net external funding; the demo does not connect to a real bank or move real money. Internal transfers do not change the sum of customer balances.

An idempotency key is unique per actor and retained with its original payload fingerprint and response. An identical retry is recorded in `idempotency_replays` and returns the original response. Reusing the key with a different payload returns HTTP 409. Refused requests are retained too, so retrying the same refused request does not later change its result.

The immutability triggers protect against normal application/API updates and deletes; they are not cryptographic protection against a person with direct access to the SQLite file. See [THREATS.md](./THREATS.md) for the trust boundary and accepted risks.

## Roles

| Action | Administrator | Account holder | Auditor |
|---|---:|---:|---:|
| View every customer account and statement | Yes | No | Yes |
| View own account and statement | Yes | Yes | Yes |
| Create accounts | Yes; assign to a holder | Yes; account is theirs | No |
| Create account-holder and auditor users | Yes | No | No |
| Deposit or withdraw | Any customer account | Own account only | No |
| Transfer | Any customer account | Own account as source; any customer destination | No |
| View all movement and audit records | Yes | Own activity | Yes |

Every API operation checks the role and account entitlement on the server. The UI is not the authorization boundary.

## Verify it

```powershell
npm test
```

Tests use temporary SQLite data and start two independent Node server processes sharing the same database file. They cover:

- Two simultaneous withdrawals that individually fit the original balance but cannot both succeed.
- A successful transfer and a replayed deposit that posts only once.
- A conflicting reuse of the same key.
- Rejection of another holder's withdrawal and all auditor posting attempts.
- CSRF enforcement, balanced postings, append-only triggers, and the nonnegative-balance trigger.

## API and deployment

- Endpoint permissions and request shapes: [API.md](./API.md)
- Threats, mitigations, and known limitations: [THREATS.md](./THREATS.md)
- AI-assistance log: [PROMPTS.md](./PROMPTS.md)
- Five-minute walkthrough outline: [DEMO_SCRIPT.md](./DEMO_SCRIPT.md)

The [Render Blueprint](./render.yaml) configures a single Node web service with a persistent disk for SQLite, production cookies, demo seeding disabled, and a generated bootstrap-admin password. Render's persistent disk requires a paid service plan. The public URL opens to the login page; this deployment does not expose demo accounts or provide public visitor credentials. Share the generated administrator password only through a private channel if the team needs to sign in.

To publish it, push this project to a GitHub repository connected to Render, choose **New → Blueprint**, select the repository, and apply the `render.yaml` configuration. When deployment completes, copy the service's `onrender.com` URL and verify that the page loads and `<your-service-url>/health` returns `{"ok":true}`. Keep the SQLite file on the persistent disk and run only one service instance; do not scale multiple replicas unless they share a filesystem with SQLite-compatible locking.

The equivalent production environment is:

```text
NODE_ENV=production
PORT=3000
DB_PATH=/var/data/ledgerline.sqlite
BOOTSTRAP_ADMIN_USERNAME=your-admin-name
BOOTSTRAP_ADMIN_PASSWORD=a-unique-password-at-least-14-characters
SEED_DEMO=false
```

Demo accounts are not seeded in production by default. Sign in as the bootstrapped administrator and create account holders and auditors. Configure the host's persistent disk at the `DB_PATH` location and terminate TLS at the host. Back up the database securely. **This is a challenge/demo application, not a production banking system**: it has no bank integration, MFA, password reset, external tamper-evident storage, or operational compliance controls.

## Challenge-submission notes

Keep your own dated work and actual commit history as you build, and update `PROMPTS.md` with what you asked, what was wrong, what you changed, and the real commit reference. This folder was not initialized as a Git repository, so no commits or public repository were created for you. Do not backdate or invent commits. Keep the repository private until the challenge permits publication. Review and explain every part of the code yourself before presenting it; AI assistance must be disclosed honestly.

The challenge also asks for a live URL, a five-minute demo video, and a short personal write-up. A deployment blueprint is provided, but the live URL is not complete until you deploy it; record and write the other deliverables yourself.
