# LedgerLine threat model

This is a local challenge/demo application. Its trust boundary is the application process and its SQLite file; the HTTP API is treated as attacker-controlled. Money is represented in integer paise. There is no real bank, external payment rail, or real customer money.

## Invariants

1. Every posted movement creates equal-value debit and credit postings. The signed sum of all posted ledger entries remains zero.
2. A customer balance never becomes negative. The balance check and every affected balance update/posting occur in one `BEGIN IMMEDIATE` transaction.
3. An actor/key pair produces no more than one movement. Identical retries return the saved original outcome; changed payloads cannot reuse the key.
4. Movement outcomes and postings are append-only through the application database triggers. Refused attempts are retained, and identified customer accounts receive a zero-value statement row showing the unchanged balance and actor.
5. The server—not the UI—checks each role and source/destination account on every request.

## Threats and mitigations

| Threat | Mitigation | Test / remaining limitation |
|---|---|---|
| Two withdrawals race and overspend one account | `BEGIN IMMEDIATE` serializes writers before balance reads; conditional update and a database trigger reject a negative customer balance. | `node --test` races two HTTP requests across two server processes sharing SQLite; asserts one 201, one 422, and the exact nonnegative balance. |
| A client retries after a timeout or double-click | Persist `(actor_user_id, client_key)`, a SHA-256 request fingerprint, result status and response in the same transaction. Replay is recorded separately and returns the saved result. | Test replays a deposit, checks unchanged balance/body and replay count; a changed payload receives 409. Keys are retained indefinitely (database growth accepted for this demo). |
| Holder forges another account ID | Check ownership from the database for every deposit/withdrawal/transfer source. Transfers may credit another customer, but cannot debit it. | Test holder B attempting a withdrawal from holder A is refused, creates a refusal statement row, and leaves A's balance unchanged. |
| Auditor attempts a write by calling the API directly | Explicit server-side read-only role check; not just hidden UI controls. | Test auditor's deposit receives 403 without changing the balance. |
| Client alters the UI or bypasses form validation | Validate movement type, account, amount, role, and balance on the server. Store amounts as integer paise. | HTTP integration tests exercise the server endpoints rather than only the browser. No real bank integration exists. |
| Attempt to overdraft through a negative or fractional amount | Require positive safe-integer paise and a sufficient balance; a database trigger independently blocks negative customer balances. | Database-level trigger is tested. |
| Application code edits or deletes ledger rows to hide activity | SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers reject edits/deletes for ledger, movement, replay, and audit tables. | Test exercises the triggers. A person with direct file/DBA access can alter the schema or database offline; there is no cryptographic hash chain or external/WORM backup. This is a known accepted risk. |
| Cross-site request uses an authenticated browser session | `HttpOnly`, `SameSite=Lax` session cookie and a per-session CSRF token required on state-changing authenticated requests; no permissive CORS. | Integration test checks a missing token is rejected. Login uses `SameSite=Lax`; no third-party assets are loaded. |
| Session token is stolen from browser JavaScript | Session cookie is `HttpOnly`; token is random and only its SHA-256 hash is stored; production cookies set `Secure`; session expires in eight hours. | TLS must be provided by the deployment host. No MFA or session revocation UI beyond sign-out is implemented. |
| Stored text causes script injection | Dynamic UI values are HTML-escaped before insertion; response headers include a restrictive same-origin Content Security Policy. | Browser behavior should still be manually checked when adding new UI fields. |
| Passwords leak from database | PBKDF2-HMAC-SHA-256 with random salt and 310,000 iterations; password hashes are not included in API responses. Production requires a unique bootstrapped admin password. | There is no password reset, MFA, or deployment secret manager integration. Admin must create strong user passwords. |
| Login is brute-forced or the service is flooded | Request body capped at 32 KiB; database busy timeout; generic invalid-credential response. | No distributed login rate limiter, proxy-level rate limiting, or DDoS protection is included. Configure these at the deployment edge before public exposure. |
| SQLite data is lost, corrupted, or split between replicas | Use a persistent disk, SQLite WAL, and a single app service; back up the DB. | Do not put the DB on ephemeral storage or scale replicas without a shared filesystem and compatible SQLite locking. SQLite is chosen for the challenge/demo, not high-availability banking workloads. |
| External funding is misrepresented as internal money | Deposits/withdrawals post against an explicit system clearing account, so all ledger postings net to zero. | Clearing is a simulated counterparty and can hold a negative balance; this app does not settle real funds. |

## Role policy

- **Administrator:** views all customer accounts/statements and audit/movement history; creates holder/auditor users and accounts; can deposit, withdraw, and transfer from any customer account.
- **Account holder:** sees own accounts; creates own accounts; can deposit to, withdraw from, or transfer out of their own accounts. A transfer may credit another customer account.
- **Auditor:** read-only access to customer accounts, statements, movements, and audit history.

Administrator authority to move any customer funds is deliberately broad for this demo and is recorded with the administrator's user ID. A production financial system should add dual approval, scoped permissions, MFA, and separation of duties.

## Known gaps (not represented as solved)

- The database append-only triggers defend against API-level edits, not a malicious host administrator with direct file access.
- The application has no independent external audit sink, cryptographic ledger verification, multi-factor authentication, distributed rate limiting, or backup automation.
- The single-currency demo uses INR, supports no real settlement or reversal workflow, and makes no claims about regulatory compliance.
- No production deployment or real-money integration is included.
