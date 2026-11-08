const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerline-test-"));
const databasePath = path.join(tempDir, "shared.sqlite");
const processes = [];

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: databasePath, NODE_ENV: "test", SEED_DEMO: "true" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  processes.push(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`LedgerLine server exited early:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return baseUrl;
    } catch { /* The child is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`LedgerLine server did not start:\n${output}`);
}

async function signIn(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return {
    baseUrl,
    csrf: body.csrfToken,
    cookie: response.headers.get("set-cookie").split(";")[0]
  };
}

async function request(client, pathname, { method = "GET", body, key = null, csrf = true } = {}) {
  const headers = { Cookie: client.cookie };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf && method !== "GET") headers["X-CSRF-Token"] = client.csrf;
  const response = await fetch(`${client.baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json()
  };
}

let serverA;
let serverB;
let admin;
let maya;
let mayaSecondSession;
let isha;
let auditor;

before(async () => {
  serverA = await startServer();
  serverB = await startServer();
  admin = await signIn(serverA, "admin", "AdminDemo!2026");
  maya = await signIn(serverA, "maya", "MayaDemo!2026");
  mayaSecondSession = await signIn(serverB, "maya", "MayaDemo!2026");
  isha = await signIn(serverB, "isha", "IshaDemo!2026");
  auditor = await signIn(serverB, "auditor", "AuditDemo!2026");
});

after(async () => {
  await Promise.all(processes.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
  })));
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Temp test data is outside the project. */ }
});

test("parallel withdrawals serialize across two processes and cannot overdraw", async () => {
  const keyOne = `race-${crypto.randomUUID()}`;
  const keyTwo = `race-${crypto.randomUUID()}`;
  const attempts = await Promise.all([
    request(maya, "/api/movements", { method: "POST", body: { type: "withdrawal", fromAccountId: "acct_maya", amountCents: 90000, clientKey: keyOne } }),
    request(mayaSecondSession, "/api/movements", { method: "POST", body: { type: "withdrawal", fromAccountId: "acct_maya", amountCents: 90000, clientKey: keyTwo } })
  ]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 422]);
  const statement = await request(maya, "/api/accounts/acct_maya/statement");
  assert.equal(statement.status, 200);
  assert.equal(statement.body.account.balance_cents, 35000);
  assert.ok(statement.body.entries.some(entry => entry.kind === "refused" && entry.balanceAfterCents === 35000));
});

test("double-entry transfers conserve money and successful retries return the original result", async () => {
  const beforeMaya = (await request(maya, "/api/accounts/acct_maya/statement")).body.account.balance_cents;
  const beforeIsha = (await request(isha, "/api/accounts/acct_isha/statement")).body.account.balance_cents;
  const transferKey = `transfer-${crypto.randomUUID()}`;
  const transfer = await request(maya, "/api/movements", {
    method: "POST",
    body: { type: "transfer", fromAccountId: "acct_maya", toAccountId: "acct_isha", amountCents: 10000, clientKey: transferKey }
  });
  assert.equal(transfer.status, 201);
  const mayaAfterTransfer = (await request(maya, "/api/accounts/acct_maya/statement")).body.account.balance_cents;
  const ishaAfterTransfer = (await request(isha, "/api/accounts/acct_isha/statement")).body.account.balance_cents;
  assert.equal(mayaAfterTransfer + ishaAfterTransfer, beforeMaya + beforeIsha);
  assert.equal(mayaAfterTransfer, beforeMaya - 10000);
  assert.equal(ishaAfterTransfer, beforeIsha + 10000);

  const depositBody = { type: "deposit", toAccountId: "acct_maya", amountCents: 2500, clientKey: `deposit-${crypto.randomUUID()}` };
  const first = await request(maya, "/api/movements", { method: "POST", body: depositBody });
  const replay = await request(maya, "/api/movements", { method: "POST", body: depositBody });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(replay.body, first.body);
  assert.equal((await request(maya, "/api/accounts/acct_maya/statement")).body.account.balance_cents, mayaAfterTransfer + 2500);

  const keyReuse = await request(maya, "/api/movements", {
    method: "POST",
    body: { ...depositBody, amountCents: 2600 }
  });
  assert.equal(keyReuse.status, 409);

  const replayCount = (await request(admin, "/api/movements")).body.movements
    .find(movement => movement.clientKey === depositBody.clientKey).replayCount;
  assert.equal(replayCount, 2);
});

test("an account holder cannot move another holder's funds; auditors are read-only", async () => {
  const mayaBefore = (await request(maya, "/api/accounts/acct_maya/statement")).body.account.balance_cents;
  const denied = await request(isha, "/api/movements", {
    method: "POST",
    body: { type: "withdrawal", fromAccountId: "acct_maya", amountCents: 1000, clientKey: `forbidden-${crypto.randomUUID()}` }
  });
  assert.equal(denied.status, 403);
  assert.equal((await request(maya, "/api/accounts/acct_maya/statement")).body.account.balance_cents, mayaBefore);
  const forbiddenDeposit = await request(isha, "/api/movements", {
    method: "POST",
    body: { type: "deposit", toAccountId: "acct_maya", amountCents: 1000, clientKey: `forbidden-deposit-${crypto.randomUUID()}` }
  });
  assert.equal(forbiddenDeposit.status, 403);
  assert.equal((await request(maya, "/api/accounts/acct_maya/statement")).body.account.balance_cents, mayaBefore);

  const auditWrite = await request(auditor, "/api/movements", {
    method: "POST",
    body: { type: "deposit", toAccountId: "acct_maya", amountCents: 500, clientKey: `audit-write-${crypto.randomUUID()}` }
  });
  assert.equal(auditWrite.status, 403);
  assert.equal((await request(maya, "/api/accounts/acct_maya/statement")).body.account.balance_cents, mayaBefore);
});

test("the dashboard is served and administrators can provision a holder and owned account", async () => {
  const page = await fetch(serverA);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /LedgerLine/);
  const stylesheet = await fetch(`${serverA}/styles.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /text\/css/);

  const username = `holder-${crypto.randomUUID().slice(0, 8)}`;
  const created = await request(admin, "/api/users", {
    method: "POST",
    body: { username, displayName: "New Holder", password: "A-Strong-Holder-Password-2026", role: "account_holder" }
  });
  assert.equal(created.status, 201);
  const account = await request(admin, "/api/accounts", {
    method: "POST",
    body: { name: "New Holder Savings", ownerUserId: created.body.user.id }
  });
  assert.equal(account.status, 201);
  assert.equal(account.body.account.balance_cents, 0);
  const holder = await signIn(serverB, username, "A-Strong-Holder-Password-2026");
  const visible = await request(holder, "/api/accounts");
  assert.deepEqual(visible.body.accounts.map(item => item.id), [account.body.account.id]);
});

test("CSRF is required and posting records are append-only and globally balanced", async () => {
  const noCsrf = await request(admin, "/api/accounts", { method: "POST", csrf: false, body: { name: "Blocked account" } });
  assert.equal(noCsrf.status, 403);

  const raw = new DatabaseSync(databasePath);
  try {
    const postingBalance = raw.prepare(`
      SELECT COALESCE(SUM(CASE WHEN entry_kind = 'credit' THEN amount_cents WHEN entry_kind = 'debit' THEN -amount_cents ELSE 0 END), 0) AS total
      FROM ledger_entries
    `).get().total;
    assert.equal(postingBalance, 0);
    assert.throws(() => raw.prepare("UPDATE ledger_entries SET description = 'tampered' WHERE id = (SELECT id FROM ledger_entries WHERE entry_kind = 'credit' LIMIT 1)").run(), /append-only/);
    assert.throws(() => raw.prepare("DELETE FROM ledger_entries WHERE id = (SELECT id FROM ledger_entries WHERE entry_kind = 'credit' LIMIT 1)").run(), /append-only/);
    assert.throws(() => raw.prepare("UPDATE movements SET status = 'refused' WHERE id = (SELECT id FROM movements WHERE status = 'posted' LIMIT 1)").run(), /append-only/);
    assert.throws(() => raw.prepare("UPDATE accounts SET balance_cents = -1 WHERE id = 'acct_maya'").run(), /cannot be negative/);
  } finally { raw.close(); }
});
