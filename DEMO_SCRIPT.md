# Five-minute demo outline

This is a recording checklist, not a demo video. Record your own screen and narrate what you can explain. Use the local demo accounts, and do not show private credentials for a public deployment.

1. **0:00–0:35 — Set the context.** Sign in as `maya`; show the balance dashboard and state that money is integer paise in SQLite.
2. **0:35–1:20 — Show the account statement.** Open Maya's account; point out the running balance, actor, and debit/credit rows.
3. **1:20–2:10 — Transfer money.** Send a small transfer from Maya to Isha. Sign in as Isha in another private browser window and show the matching credit.
4. **2:10–2:55 — Show exactly-once and failure behavior.** Demonstrate that resubmitting the same idempotency key returns the original movement; explain that a changed payload with that key is rejected. Do not pretend a plain second form submission reuses a key—show it in a test/API request if needed.
5. **2:55–3:45 — Show authorization and roles.** Attempt a Maya withdrawal while signed in as Isha and show the refusal. Sign in as auditor and show read-only access.
6. **3:45–4:35 — Explain the race test.** Run `npm test`; show the two-process concurrent-withdrawal test and the final balance.
7. **4:35–5:00 — State limitations honestly.** Explain SQLite locking, the local demo clearing account, and the absence of real bank rails, MFA, and an external tamper-evident audit store.
