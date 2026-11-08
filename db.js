const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEMO_USERS = [
  { id: "usr_admin", username: "admin", password: "AdminDemo!2026", role: "administrator", displayName: "Ledger Administrator" },
  { id: "usr_maya", username: "maya", password: "MayaDemo!2026", role: "account_holder", displayName: "Maya Rao" },
  { id: "usr_isha", username: "isha", password: "IshaDemo!2026", role: "account_holder", displayName: "Isha Nair" },
  { id: "usr_auditor", username: "auditor", password: "AuditDemo!2026", role: "auditor", displayName: "Read-only Auditor" }
];

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const digest = crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256");
  return `pbkdf2$${salt.toString("hex")}$${digest.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, digestHex] = String(stored || "").split("$");
  if (scheme !== "pbkdf2" || !saltHex || !digestHex) return false;
  const expected = Buffer.from(digestHex, "hex");
  const actual = crypto.pbkdf2Sync(password, Buffer.from(saltHex, "hex"), 310000, expected.length, "sha256");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function openDatabase(filename) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('administrator', 'account_holder', 'auditor')),
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      balance_cents INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS account_owners (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (account_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS movements (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      client_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'transfer')),
      from_account_id TEXT,
      to_account_id TEXT,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('posted', 'refused')),
      http_status INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(actor_user_id, client_key)
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      movement_id TEXT NOT NULL REFERENCES movements(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      entry_kind TEXT NOT NULL CHECK (entry_kind IN ('debit', 'credit', 'refused')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      balance_after_cents INTEGER NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK ((entry_kind = 'refused' AND amount_cents = 0) OR (entry_kind != 'refused' AND amount_cents > 0))
    );
    CREATE INDEX IF NOT EXISTS ledger_account_time ON ledger_entries(account_id, created_at, id);
    CREATE TABLE IF NOT EXISTS idempotency_replays (
      id TEXT PRIMARY KEY,
      movement_id TEXT NOT NULL REFERENCES movements(id),
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      client_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      resource_id TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TRIGGER IF NOT EXISTS accounts_no_negative_customer_balance
    BEFORE UPDATE OF balance_cents ON accounts
    WHEN NEW.is_system = 0 AND NEW.balance_cents < 0
    BEGIN SELECT RAISE(ABORT, 'customer balance cannot be negative'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_no_update
    BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_no_delete
    BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS movements_no_update
    BEFORE UPDATE ON movements BEGIN SELECT RAISE(ABORT, 'movements are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS movements_no_delete
    BEFORE DELETE ON movements BEGIN SELECT RAISE(ABORT, 'movements are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS replays_no_update
    BEFORE UPDATE ON idempotency_replays BEGIN SELECT RAISE(ABORT, 'replay records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS replays_no_delete
    BEFORE DELETE ON idempotency_replays BEGIN SELECT RAISE(ABORT, 'replay records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_update
    BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete
    BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
  `);
  db.prepare("INSERT OR IGNORE INTO accounts (id, name, is_system) VALUES ('acct_clearing', 'External clearing', 1)").run();
  return db;
}

function seedDemoData(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const user of DEMO_USERS) {
      if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(user.id)) {
        db.prepare(`
          INSERT INTO users (id, username, password_hash, role, display_name)
          VALUES (?, ?, ?, ?, ?)
        `).run(user.id, user.username, hashPassword(user.password), user.role, user.displayName);
      }
    }

    const insertAccount = db.prepare(`
      INSERT OR IGNORE INTO accounts (id, name, balance_cents, is_system)
      VALUES (?, ?, ?, ?)
    `);
    insertAccount.run("acct_maya", "Maya · Everyday", 125000, 0);
    insertAccount.run("acct_isha", "Isha · Operations", 80000, 0);
    insertAccount.run("acct_clearing", "External clearing", -205000, 1);
    db.prepare("INSERT OR IGNORE INTO account_owners (account_id, user_id) VALUES (?, ?)").run("acct_maya", "usr_maya");
    db.prepare("INSERT OR IGNORE INTO account_owners (account_id, user_id) VALUES (?, ?)").run("acct_isha", "usr_isha");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function bootstrapAdmin(db, username, password) {
  if (!username || !password || password.length < 14) {
    throw new Error("Set BOOTSTRAP_ADMIN_USERNAME and a BOOTSTRAP_ADMIN_PASSWORD of at least 14 characters.");
  }
  db.prepare(`
    INSERT OR IGNORE INTO users (id, username, password_hash, role, display_name)
    VALUES (?, ?, ?, 'administrator', ?)
  `).run(crypto.randomUUID(), username, hashPassword(password), "Ledger Administrator");
}

module.exports = { DEMO_USERS, bootstrapAdmin, hashPassword, openDatabase, seedDemoData, verifyPassword };
