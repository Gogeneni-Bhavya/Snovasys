const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { bootstrapAdmin, hashPassword, openDatabase, seedDemoData, verifyPassword } = require("./db");

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "ledgerline.sqlite");
const DEMO_ENABLED = process.env.SEED_DEMO === "true" ||
  (process.env.SEED_DEMO !== "false" && process.env.NODE_ENV !== "production");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const db = openDatabase(DB_PATH);

if (DEMO_ENABLED) seedDemoData(db);
else if (process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  bootstrapAdmin(db, process.env.BOOTSTRAP_ADMIN_USERNAME || "admin", process.env.BOOTSTRAP_ADMIN_PASSWORD);
}

function audit(actorId, action, resourceId, details = {}) {
  db.prepare(`
    INSERT INTO audit_events (id, actor_user_id, action, resource_id, details_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), actorId || null, action, resourceId || null, JSON.stringify(details));
}

function transaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function jsonResponse(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > 32_768) {
        tooLarge = true;
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function getCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(part => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { return [name, decodeURIComponent(value)]; } catch { return [name, ""]; }
  }).filter(([name]) => name));
}

function getSession(req) {
  const token = getCookies(req).ledgerline_session;
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = db.prepare(`
    SELECT s.token_hash, s.csrf_token, u.id, u.username, u.role, u.display_name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, Date.now());
  return row ? { tokenHash: row.token_hash, csrfToken: row.csrf_token, user: {
    id: row.id, username: row.username, role: row.role, displayName: row.display_name
  } } : null;
}

function hasAccountAccess(user, accountId) {
  if (!accountId) return false;
  if (user.role === "administrator" || user.role === "auditor") {
    return Boolean(db.prepare("SELECT 1 FROM accounts WHERE id = ? AND is_system = 0 AND active = 1").get(accountId));
  }
  return Boolean(db.prepare(`
    SELECT 1 FROM accounts a JOIN account_owners o ON o.account_id = a.id
    WHERE a.id = ? AND a.active = 1 AND a.is_system = 0 AND o.user_id = ?
  `).get(accountId, user.id));
}

function accountById(id) {
  return db.prepare("SELECT id, name, currency, balance_cents, is_system, active FROM accounts WHERE id = ?").get(id);
}

function canManageAccount(user, accountId) {
  return user.role === "administrator" || hasAccountAccess(user, accountId);
}

function insertMovement(actorId, key, fingerprint, movement, status, httpStatus, response, movementId = crypto.randomUUID()) {
  db.prepare(`
    INSERT INTO movements (id, actor_user_id, client_key, fingerprint, type, from_account_id,
      to_account_id, amount_cents, status, http_status, response_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(movementId, actorId, key, fingerprint, movement.type, movement.fromAccountId || null,
    movement.toAccountId || null, movement.amountCents, status, httpStatus, JSON.stringify(response));
  return movementId;
}

function recordRefusal(movementId, actorId, account, reason) {
  if (!account) return;
  db.prepare(`
    INSERT INTO ledger_entries (id, movement_id, account_id, actor_user_id, entry_kind, amount_cents,
      balance_after_cents, description)
    VALUES (?, ?, ?, ?, 'refused', 0, ?, ?)
  `).run(crypto.randomUUID(), movementId, account.id, actorId, account.balance_cents, reason);
}

function moneyMovement(user, input) {
  const type = input.type;
  const movement = {
    type,
    fromAccountId: typeof input.fromAccountId === "string" ? input.fromAccountId : "",
    toAccountId: typeof input.toAccountId === "string" ? input.toAccountId : "",
    amountCents: Number.isSafeInteger(input.amountCents) ? input.amountCents : -1,
    description: typeof input.description === "string" ? input.description.trim().slice(0, 120) : ""
  };
  const key = typeof input.clientKey === "string" ? input.clientKey.trim() : "";
  if (!/^[\w.:-]{8,128}$/.test(key)) return { status: 400, body: { error: "Provide an 8–128 character idempotency key." } };
  if (!["deposit", "withdrawal", "transfer"].includes(type)) {
    return { status: 400, body: { error: "Movement type must be deposit, withdrawal, or transfer." } };
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(movement)).digest("hex");

  return transaction(() => {
    const existing = db.prepare("SELECT * FROM movements WHERE actor_user_id = ? AND client_key = ?").get(user.id, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        db.prepare(`
          INSERT INTO idempotency_replays (id, movement_id, actor_user_id, client_key)
          VALUES (?, ?, ?, ?)
        `).run(crypto.randomUUID(), existing.id, user.id, key);
        audit(user.id, "idempotency.key_conflict", existing.id, { clientKey: key });
        return { status: 409, body: { error: "This idempotency key was already used for a different request." } };
      }
      db.prepare(`
        INSERT INTO idempotency_replays (id, movement_id, actor_user_id, client_key)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), existing.id, user.id, key);
      audit(user.id, "idempotency.replayed", existing.id, { clientKey: key });
      return { status: existing.http_status, body: JSON.parse(existing.response_json), headers: { "Idempotency-Replayed": "true" } };
    }

    const source = movement.fromAccountId ? accountById(movement.fromAccountId) : null;
    const destination = movement.toAccountId ? accountById(movement.toAccountId) : null;
    let refusal = null;
    if (!Number.isSafeInteger(movement.amountCents) || movement.amountCents <= 0) refusal = "Amount must be a positive whole number of paise.";
    else if (user.role === "auditor") refusal = "Auditors have read-only access.";
    else if (type === "deposit" && (!destination || destination.is_system || !destination.active)) refusal = "Destination account was not found.";
    else if (type === "withdrawal" && (!source || source.is_system || !source.active)) refusal = "Source account was not found.";
    else if (type === "transfer" && (!source || source.is_system || !source.active || !destination || destination.is_system || !destination.active)) refusal = "Source or destination account was not found.";
    else if (type === "transfer" && source.id === destination.id) refusal = "Choose two different accounts.";
    else if (type !== "deposit" && !canManageAccount(user, source.id)) refusal = "You are not allowed to use this source account.";
    else if (type === "deposit" && !canManageAccount(user, destination.id)) refusal = "You are not allowed to use this destination account.";
    else if (type === "transfer" && !canManageAccount(user, source.id)) refusal = "You are not allowed to use this source account.";
    else if (type === "transfer" && source.currency !== destination.currency) refusal = "Accounts must use the same currency.";
    else if (type === "withdrawal" && source.balance_cents < movement.amountCents) refusal = "Insufficient funds.";
    else if (type === "transfer" && source.balance_cents < movement.amountCents) refusal = "Insufficient funds.";

    if (refusal) {
      const response = { error: refusal };
      const status = /not allowed|read-only/.test(refusal) ? 403 : 422;
      const movementId = insertMovement(user.id, key, fingerprint, movement, "refused", status, response);
      const affectedAccount = type === "deposit" ? destination : source;
      recordRefusal(movementId, user.id, affectedAccount && !affectedAccount.is_system ? affectedAccount : null, refusal);
      audit(user.id, "movement.refused", movementId, { type, reason: refusal, accountId: affectedAccount?.id || null });
      return { status, body: response };
    }

    const clearing = db.prepare("SELECT * FROM accounts WHERE id = 'acct_clearing' AND is_system = 1").get();
    if (!clearing) throw new Error("System clearing account is missing.");

    const movementId = crypto.randomUUID();
    const response = {
      movementId, type, status: "posted", amountCents: movement.amountCents,
      fromAccountId: movement.fromAccountId || null, toAccountId: movement.toAccountId || null,
      clientKey: key
    };
    insertMovement(user.id, key, fingerprint, movement, "posted", 201, response, movementId);
    const postings = type === "deposit"
      ? [{ account: destination, delta: movement.amountCents, kind: "credit" }, { account: clearing, delta: -movement.amountCents, kind: "debit" }]
      : type === "withdrawal"
        ? [{ account: source, delta: -movement.amountCents, kind: "debit" }, { account: clearing, delta: movement.amountCents, kind: "credit" }]
        : [{ account: source, delta: -movement.amountCents, kind: "debit" }, { account: destination, delta: movement.amountCents, kind: "credit" }];

    const insertEntry = db.prepare(`
      INSERT INTO ledger_entries (id, movement_id, account_id, actor_user_id, entry_kind, amount_cents,
        balance_after_cents, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateBalance = db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ? AND active = 1");
    for (const posting of postings) {
      updateBalance.run(posting.delta, posting.account.id);
      const updated = accountById(posting.account.id);
      insertEntry.run(crypto.randomUUID(), movementId, posting.account.id, user.id, posting.kind,
        movement.amountCents, updated.balance_cents, movement.description || `${type} · ${key}`);
    }
    audit(user.id, `movement.${type}`, movementId, { amountCents: movement.amountCents, fromAccountId: movement.fromAccountId || null, toAccountId: movement.toAccountId || null });
    return { status: 201, body: response };
  });
}

function parseAccountId(pathname, suffix) {
  const match = pathname.match(new RegExp(`^/api/accounts/([^/]+)/${suffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";
  if (method === "GET" && pathname === "/health") {
    return jsonResponse(res, 200, { ok: true, service: "LedgerLine" });
  }
  if (pathname.startsWith("/api/")) {
    const session = getSession(req);
    if (pathname === "/api/login" && method === "POST") {
      const body = await readBody(req);
      const username = typeof body.username === "string" ? body.username.trim().slice(0, 80) : "";
      const password = typeof body.password === "string" ? body.password : "";
      const user = db.prepare("SELECT id, username, password_hash, role, display_name FROM users WHERE username = ?").get(username);
      if (!user || !verifyPassword(password, user.password_hash)) {
        audit(user?.id, "auth.login_failed", null, { username });
        return jsonResponse(res, 401, { error: "Username or password is incorrect." });
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const csrfToken = crypto.randomBytes(24).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
      db.prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)").run(tokenHash, user.id, csrfToken, Date.now() + SESSION_TTL_MS);
      audit(user.id, "auth.login", null);
      return jsonResponse(res, 200, {
        user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
        csrfToken
      }, { "Set-Cookie": `ledgerline_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}` });
    }
    if (!session) return jsonResponse(res, 401, { error: "Sign in to continue." });
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const csrf = req.headers["x-csrf-token"];
      const expected = Buffer.from(session.csrfToken);
      const supplied = Buffer.from(typeof csrf === "string" ? csrf : "");
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
        return jsonResponse(res, 403, { error: "CSRF token is missing or invalid." });
      }
    }
    if (method === "POST" && pathname === "/api/logout") {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.tokenHash);
      audit(session.user.id, "auth.logout", null);
      return jsonResponse(res, 200, { ok: true }, { "Set-Cookie": "ledgerline_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }
    if (method === "GET" && pathname === "/api/me") {
      return jsonResponse(res, 200, { user: session.user, csrfToken: session.csrfToken });
    }
    if (method === "GET" && pathname === "/api/accounts") {
      const accounts = session.user.role === "administrator" || session.user.role === "auditor"
        ? db.prepare("SELECT a.id, a.name, a.currency, a.balance_cents, a.active, GROUP_CONCAT(u.display_name, ', ') AS owners FROM accounts a LEFT JOIN account_owners o ON o.account_id = a.id LEFT JOIN users u ON u.id = o.user_id WHERE a.is_system = 0 GROUP BY a.id ORDER BY a.rowid").all()
        : db.prepare("SELECT a.id, a.name, a.currency, a.balance_cents, a.active, u.display_name AS owners FROM accounts a JOIN account_owners o ON o.account_id = a.id JOIN users u ON u.id = o.user_id WHERE a.is_system = 0 AND o.user_id = ? ORDER BY a.rowid").all(session.user.id);
      return jsonResponse(res, 200, { accounts });
    }
    if (method === "POST" && pathname === "/api/accounts") {
      if (session.user.role === "auditor") return jsonResponse(res, 403, { error: "Auditors have read-only access." });
      const body = await readBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > 80) return jsonResponse(res, 400, { error: "Account name must be 2–80 characters." });
      const ownerId = session.user.role === "administrator" && typeof body.ownerUserId === "string" ? body.ownerUserId : session.user.id;
      const owner = db.prepare("SELECT id, role FROM users WHERE id = ?").get(ownerId);
      if (!owner || owner.role === "auditor") return jsonResponse(res, 400, { error: "Choose an existing account holder." });
      const accountId = `acct_${crypto.randomUUID()}`;
      transaction(() => {
        db.prepare("INSERT INTO accounts (id, name) VALUES (?, ?)").run(accountId, name);
        db.prepare("INSERT INTO account_owners (account_id, user_id) VALUES (?, ?)").run(accountId, ownerId);
        audit(session.user.id, "account.created", accountId, { ownerUserId: ownerId });
      });
      return jsonResponse(res, 201, { account: accountById(accountId) });
    }
    if (method === "GET" && pathname === "/api/users") {
      if (session.user.role !== "administrator") return jsonResponse(res, 403, { error: "Administrator access required." });
      const users = db.prepare("SELECT id, username, role, display_name AS displayName FROM users ORDER BY username").all();
      return jsonResponse(res, 200, { users });
    }
    if (method === "POST" && pathname === "/api/users") {
      if (session.user.role !== "administrator") return jsonResponse(res, 403, { error: "Administrator access required." });
      const body = await readBody(req);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const role = body.role;
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return jsonResponse(res, 400, { error: "Username must be 3–32 letters, numbers, dots, underscores or hyphens." });
      if (displayName.length < 2 || displayName.length > 80) return jsonResponse(res, 400, { error: "Display name must be 2–80 characters." });
      if (password.length < 14) return jsonResponse(res, 400, { error: "Password must be at least 14 characters." });
      if (!["account_holder", "auditor"].includes(role)) return jsonResponse(res, 400, { error: "Choose an account holder or auditor role." });
      const id = `usr_${crypto.randomUUID()}`;
      try {
        db.prepare("INSERT INTO users (id, username, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?)")
          .run(id, username, hashPassword(password), role, displayName);
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return jsonResponse(res, 409, { error: "That username is already in use." });
        throw error;
      }
      audit(session.user.id, "user.created", id, { role });
      return jsonResponse(res, 201, { user: { id, username, role, displayName } });
    }
    if (method === "GET" && pathname === "/api/movements") {
      const query = session.user.role === "administrator" || session.user.role === "auditor"
        ? db.prepare("SELECT m.id, m.actor_user_id AS actorUserId, u.display_name AS actor, m.client_key AS clientKey, m.type, m.from_account_id AS fromAccountId, m.to_account_id AS toAccountId, m.amount_cents AS amountCents, m.status, m.created_at AS createdAt, (SELECT COUNT(*) FROM idempotency_replays r WHERE r.movement_id=m.id) AS replayCount FROM movements m JOIN users u ON u.id=m.actor_user_id ORDER BY m.rowid DESC LIMIT 200").all()
        : db.prepare("SELECT DISTINCT m.id, m.actor_user_id AS actorUserId, u.display_name AS actor, m.client_key AS clientKey, m.type, m.from_account_id AS fromAccountId, m.to_account_id AS toAccountId, m.amount_cents AS amountCents, m.status, m.created_at AS createdAt, (SELECT COUNT(*) FROM idempotency_replays r WHERE r.movement_id=m.id) AS replayCount FROM movements m JOIN users u ON u.id=m.actor_user_id LEFT JOIN ledger_entries e ON e.movement_id=m.id LEFT JOIN account_owners o ON o.account_id=e.account_id WHERE o.user_id = ? OR m.actor_user_id = ? ORDER BY m.rowid DESC LIMIT 200").all(session.user.id, session.user.id);
      return jsonResponse(res, 200, { movements: query });
    }
    if (method === "POST" && pathname === "/api/movements") {
      const body = await readBody(req);
      const result = moneyMovement(session.user, body);
      return jsonResponse(res, result.status, result.body, result.headers);
    }
    if (method === "GET" && pathname === "/api/audit") {
      if (session.user.role !== "administrator" && session.user.role !== "auditor") return jsonResponse(res, 403, { error: "Administrator or auditor access required." });
      const events = db.prepare("SELECT a.id, a.actor_user_id AS actorUserId, u.display_name AS actor, a.action, a.resource_id AS resourceId, a.details_json AS details, a.created_at AS createdAt FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.rowid DESC LIMIT 200").all();
      return jsonResponse(res, 200, { events: events.map(event => ({ ...event, details: JSON.parse(event.details) })) });
    }
    const accountId = parseAccountId(pathname, "statement");
    if (method === "GET" && accountId) {
      if (!hasAccountAccess(session.user, accountId)) return jsonResponse(res, 404, { error: "Account not found." });
      const account = accountById(accountId);
      const entries = db.prepare(`
        SELECT e.id, e.movement_id AS movementId, e.entry_kind AS kind, e.amount_cents AS amountCents,
          e.balance_after_cents AS balanceAfterCents, e.description, e.actor_user_id AS actorUserId,
          u.display_name AS actor, e.created_at AS createdAt, m.type, m.status
        FROM ledger_entries e JOIN users u ON u.id=e.actor_user_id JOIN movements m ON m.id=e.movement_id
        WHERE e.account_id = ? ORDER BY e.rowid DESC LIMIT 200
      `).all(accountId);
      return jsonResponse(res, 200, { account: { ...account, owners: db.prepare("SELECT u.display_name AS name FROM account_owners o JOIN users u ON u.id=o.user_id WHERE o.account_id=?").all(accountId).map(owner => owner.name) }, entries });
    }
    return jsonResponse(res, 404, { error: "API endpoint not found." });
  }

  if (method !== "GET" && method !== "HEAD") return jsonResponse(res, 405, { error: "Method not allowed." });
  const requestedPath = pathname === "/" ? "index.html" : path.normalize(decodeURIComponent(pathname).replace(/^[/\\]+/, ""));
  const filePath = path.resolve(PUBLIC_DIR, requestedPath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    return jsonResponse(res, 404, { error: "Not found." });
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return jsonResponse(res, 404, { error: "Not found." });
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
  res.writeHead(200, {
    "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  if (method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    if (res.headersSent) return res.destroy(error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status === 500) console.error("Request failed:", error.message);
    jsonResponse(res, status, { error: status === 500 ? "An unexpected server error occurred." : error.message });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LedgerLine running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  if (DEMO_ENABLED) console.log("Demo accounts enabled; see README.md for credentials.");
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
