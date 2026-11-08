# AI-assisted development log

Entries below were written during the actual build session on **2026-11-08**; they are not backdated. The challenge requires maintaining this file as you work. No Git repository or commits existed in this folder when work began, so commit references are explicitly pending rather than invented. Add your own dated entries and real commit links as you continue.

## 2026-11-08 — Identify the real problem statement

- **Prompt/instruction:** The initial request was to explain how to develop the project from the pasted challenge instructions; the follow-up asked to build it in `LedgerLine`.
- **AI output:** The first explanation mistakenly treated the challenge website's profile/submission form as the application requirements.
- **What was wrong:** The pasted content also contained the actual LedgerLine money-ledger problem statement. A profile-form app would not meet it.
- **Correction/check:** Read the rest of the attachment and mapped the implementation to money movement, roles, double-entry, idempotency, concurrency, statements, and audit history.
- **Commit:** Pending; no commit has been created.

## 2026-11-08 — Keep the movement record append-only from insertion

- **Prompt/instruction:** Implement stored idempotent movement results while preserving the statement's append-only requirement.
- **AI output:** The initial implementation inserted a posted movement and then attempted to update its response JSON.
- **What was wrong:** The append-only update trigger correctly blocked that update; the first successful post would have failed and rolled back.
- **Correction/check:** Build the movement ID and complete response first, insert the final movement row once, and never update it. The integration suite checks movement-row updates are rejected.
- **Commit:** Pending; no commit has been created.

## 2026-11-08 — Enforce access control on the API, not only the interface

- **Prompt/instruction:** Apply the administrator, account-holder, and read-only-auditor policy on every money-moving route.
- **AI output:** During the implementation review, the first route draft did not constrain a holder's deposit destination and did not block an auditor from a transfer.
- **What was wrong:** Both paths relied on incomplete role checks; calling the endpoint directly could bypass the intended policy.
- **Correction/check:** Check the destination entitlement for holder deposits and refuse all auditor movements in the shared server-side movement handler. Add direct HTTP tests for cross-owner withdrawal and auditor posting.
- **Commit:** Pending; no commit has been created.

## 2026-11-08 — Make the concurrency test exercise competing authorized requests

- **Prompt/instruction:** Test simultaneous withdrawals through two app processes sharing one SQLite database.
- **AI output:** The first draft sent the second withdrawal as a different account holder.
- **What was wrong:** That request would fail authorization before the balance check, so it would not prove the no-overdraft race property.
- **Correction/check:** Authenticate the same holder in each process, submit two distinct 90,000-paise withdrawal keys concurrently against a 125,000-paise balance, and assert one posts, one is refused for insufficient funds, and the resulting balance is 35,000 paise.
- **Commit:** Pending; no commit has been created.

## 2026-11-08 — Keep the browser inside the declared security boundary

- **Prompt/instruction:** Finish the dashboard using the same-origin Content Security Policy.
- **AI output:** The initial HTML included remote font stylesheets from a third-party host.
- **What was wrong:** The app's CSP disallowed those requests, and loading an external asset was unnecessary for this demo.
- **Correction/check:** Remove external font links and use local/system font fallbacks; escape user- and ledger-derived HTML before rendering it.
- **Commit:** Pending; no commit has been created.

These notes describe the AI-assisted work in this session; they are not substitutes for your own understanding or for the commit history requested by the challenge. Do not fabricate prompts, findings, or commits.
