# LedgerLine HTTP API

All API responses are JSON. The browser uses a same-origin `HttpOnly`, `SameSite=Lax` session cookie. Sessions expire after eight hours. Authenticated state-changing requests require the session's CSRF token in `X-CSRF-Token`. There is no CORS allow-list because cross-origin access is not enabled.

Money fields use integer **paise** (`amountCents`), not decimal rupees. Movement idempotency keys are scoped to the authenticated user and retained indefinitely.

## Authentication

| Method and path | Access | Behavior |
|---|---|---|
| `POST /api/login` | Public | `{ "username": "...", "password": "..." }`. Creates a session cookie; returns user details and `csrfToken`. |
| `GET /api/me` | Signed in | Returns the current user and CSRF token. |
| `POST /api/logout` | Signed in + CSRF | Deletes the current session. |

## Accounts and statements

| Method and path | Access | Behavior |
|---|---|---|
| `GET /api/accounts` | Signed in | Admin/auditor see all customer accounts; holder sees only owned accounts. |
| `POST /api/accounts` | Admin or holder + CSRF | `{ "name": "..." }`; admin may also provide `ownerUserId`. New account starts at zero. |
| `GET /api/accounts/:id/statement` | Account owner, admin, or auditor | Returns account balance and up to 200 newest credits, debits, and refused attempts with running balances and initiators. Other holders receive 404. |
| `GET /api/users` | Admin | Returns user IDs, usernames, display names, and roles; never password hashes. |
| `POST /api/users` | Admin + CSRF | Creates an account-holder or auditor. Requires `username`, `displayName`, `password` (at least 14 characters), and role. |

## Money movements

### `POST /api/movements`

Signed-in administrator or account holder + CSRF. Auditors are read-only. Every request needs:

```json
{
  "type": "transfer",
  "fromAccountId": "acct_maya",
  "toAccountId": "acct_isha",
  "amountCents": 1250,
  "description": "Invoice 1042",
  "clientKey": "a-unique-client-key-123"
}
```

`type` is `transfer`, `deposit`, or `withdrawal`. Deposits use `toAccountId`; withdrawals use `fromAccountId`; transfers use both. Amount must be a positive safe integer. The browser converts decimal rupees to integer paise before sending.

- A new posted request returns HTTP 201 and a movement result.
- Insufficient funds or other invalid movement returns HTTP 422 and is retained as a refused request.
- Account authorization failures return HTTP 403 (unknown or inaccessible statement accounts return 404).
- An identical key and payload returns the original status and response with `Idempotency-Replayed: true`; no second posting is made.
- Reusing a key with a different payload returns HTTP 409.

### Movement and audit history

| Method and path | Access | Behavior |
|---|---|---|
| `GET /api/movements` | Signed in | Admin/auditor see up to 200 newest requests; holder sees requests they initiated or that touch an account they own. Includes refusal status and replay count. |
| `GET /api/audit` | Admin or auditor | Returns up to 200 newest authentication, account, movement, refusal, and replay events. |
| `GET /health` | Public | Process health check only; returns no financial data. |

## Consistency details

The server validates each movement and writes the movement record, account balance updates, double-entry postings, and audit event inside one `BEGIN IMMEDIATE` SQLite transaction. Refusals are also stored in that transaction and have a zero-value statement row when an affected customer account can be identified. SQLite triggers prevent normal updates/deletes of ledger, movement, replay, and audit rows and prevent negative customer balances.
