const state = { user: null, csrf: "", accounts: [], movements: [], view: "overview", movementType: "transfer", toastTimer: null };
const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const amount = cents => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(cents / 100);
const dateLabel = value => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const roleLabel = role => ({ administrator: "Administrator", account_holder: "Account holder", auditor: "Auditor · read only" }[role] || role);

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (state.csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(url, { credentials: "same-origin", ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return { body, response };
}

function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
}

function showView(name) {
  state.view = name;
  $$(".view-panel").forEach(panel => panel.classList.toggle("hidden", panel.id !== `${name}-view`));
  $$(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  $("#breadcrumb-current").textContent = ({ overview: "Overview", accounts: "Accounts", activity: "Activity", audit: "Audit trail" })[name] || "Overview";
  if (name === "audit") loadAudit();
}

function getAccount(id) { return state.accounts.find(account => account.id === id); }
function nameFor(id) { return getAccount(id)?.name || (id === "acct_clearing" ? "External clearing" : "—"); }

function accountCard(account) {
  return `<article class="account-card" data-account-id="${escapeHtml(account.id)}" tabindex="0" role="button" aria-label="View statement for ${escapeHtml(account.name)}">
    <div class="account-card-head"><span class="account-glyph">▤</span><span><span class="account-name">${escapeHtml(account.name)}</span><span class="account-owner">${escapeHtml(account.owners || "You")}</span></span></div>
    <div class="account-amount">${amount(account.balance_cents)}</div>
    <div class="account-footer"><span>${escapeHtml(account.currency)} · account</span><span class="account-open">View statement →</span></div>
  </article>`;
}

function activityRow(movement) {
  const outgoing = movement.type === "withdrawal" || (movement.fromAccountId && movement.actorUserId === state.user.id);
  const signed = movement.status === "posted" ? (outgoing ? -movement.amountCents : movement.amountCents) : 0;
  const symbol = movement.status === "refused" ? "×" : outgoing ? "↗" : "↙";
  const detail = movement.type === "transfer"
    ? `${escapeHtml(nameFor(movement.fromAccountId))} → ${escapeHtml(nameFor(movement.toAccountId))}`
    : `${escapeHtml(movement.type)} · ${escapeHtml(nameFor(movement.fromAccountId || movement.toAccountId))}`;
  return `<div class="activity-row"><span class="activity-icon ${outgoing ? "outgoing" : ""}">${symbol}</span><div class="activity-copy"><strong>${escapeHtml(movement.type)} · ${escapeHtml(movement.status)}</strong><small>${detail} · ${escapeHtml(movement.actor || "You")} · ${dateLabel(movement.createdAt)}</small></div><span class="activity-value ${movement.status === "refused" ? "muted" : signed < 0 ? "negative" : "positive"}">${movement.status === "refused" ? "—" : `${signed < 0 ? "−" : "+"}${amount(Math.abs(signed))}`}</span></div>`;
}

function render() {
  const total = state.accounts.reduce((sum, account) => sum + account.balance_cents, 0);
  $("#user-name").textContent = state.user.displayName;
  $("#user-role").textContent = roleLabel(state.user.role);
  $("#user-avatar").textContent = state.user.displayName.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  $("#greeting-name").textContent = state.user.displayName.split(" ")[0];
  $("#total-balance").textContent = amount(total);
  $("#account-count").textContent = state.accounts.length;
  $("#movement-count").textContent = state.movements.length;
  $("#account-total-label").textContent = `Across ${state.accounts.length} account${state.accounts.length === 1 ? "" : "s"}`;
  $("#activity-count").textContent = state.movements.length;
  $("#overview-accounts").innerHTML = state.accounts.slice(0, 3).map(accountCard).join("") || '<div class="empty-state">No accounts yet. Create one to get started.</div>';
  $("#accounts-list").innerHTML = state.accounts.map(accountCard).join("") || '<div class="empty-state">No accounts yet. Create an account to get started.</div>';
  $("#recent-activity").innerHTML = state.movements.slice(0, 5).map(activityRow).join("") || '<div class="empty-state">Your first movement will appear here.</div>';
  $("#activity-rows").innerHTML = state.movements.map(movement => `<tr><td><span class="status-tag ${movement.status === "refused" ? "refused" : ""}">${escapeHtml(movement.status)}</span></td><td>${escapeHtml(movement.type)}</td><td class="mono">${amount(movement.amountCents)}</td><td>${escapeHtml(nameFor(movement.fromAccountId))} → ${escapeHtml(nameFor(movement.toAccountId))}</td><td>${escapeHtml(movement.actor)}</td><td class="mono">${escapeHtml(movement.clientKey)}${movement.replayCount ? ` · ${movement.replayCount} replay${movement.replayCount === 1 ? "" : "s"}` : ""}</td><td>${dateLabel(movement.createdAt)}</td></tr>`).join("") || '<tr><td colspan="7" class="empty-state">No movement requests recorded.</td></tr>';
  const accountOptions = state.accounts.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${amount(account.balance_cents)}</option>`).join("");
  $("#movement-source").innerHTML = accountOptions;
  $("#movement-destination").innerHTML = accountOptions;
  const holder = state.user.role === "administrator";
  $$(".role-admin-only").forEach(element => element.classList.toggle("hidden", !holder));
  $$(".role-auditor-only").forEach(element => element.classList.toggle("hidden", state.user.role !== "auditor" && state.user.role !== "administrator"));
  $("#create-account-open").classList.toggle("hidden", state.user.role === "auditor");
  $("#create-user-open").classList.toggle("hidden", state.user.role !== "administrator");
  $("#create-account-form .admin-field").classList.toggle("hidden", state.user.role !== "administrator");
  $("#account-owner").innerHTML = state.users?.filter(user => user.role === "account_holder").map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName)}</option>`).join("") || "";
}

async function loadData() {
  const [{ body: accountBody }, { body: movementBody }] = await Promise.all([api("/api/accounts"), api("/api/movements")]);
  state.accounts = accountBody.accounts;
  state.movements = movementBody.movements;
  if (state.user.role === "administrator") {
    const { body } = await api("/api/users");
    state.users = body.users;
  }
  render();
}

async function loadAudit() {
  try {
    const { body } = await api("/api/audit");
    $("#audit-rows").innerHTML = body.events.map(event => `<tr><td><span class="mono">${escapeHtml(event.action)}</span></td><td>${escapeHtml(event.actor || "System")}</td><td class="mono">${escapeHtml(event.resourceId || "—")}</td><td>${escapeHtml(JSON.stringify(event.details))}</td><td>${dateLabel(event.createdAt)}</td></tr>`).join("") || '<tr><td colspan="5" class="empty-state">No audit events.</td></tr>';
  } catch (error) { toast(error.message, true); }
}

async function loadStatement(accountId) {
  try {
    const { body } = await api(`/api/accounts/${encodeURIComponent(accountId)}/statement`);
    $("#statement-title").textContent = body.account.name;
    $("#statement-balance").textContent = `${amount(body.account.balance_cents)} · ${body.account.owners.join(", ") || "No owner"}`;
    $("#statement-rows").innerHTML = body.entries.map(entry => {
      const direction = entry.kind === "credit" ? "+" : entry.kind === "debit" ? "−" : "";
      const kind = entry.kind === "refused" ? '<span class="status-tag refused">refused</span>' : `<span class="status-tag">${escapeHtml(entry.kind)}</span>`;
      return `<tr><td>${kind}</td><td>${escapeHtml(entry.description)}</td><td>${escapeHtml(entry.actor)}</td><td>${dateLabel(entry.createdAt)}</td><td class="mono ${direction === "+" ? "positive" : direction ? "negative" : "muted"}">${direction}${entry.kind === "refused" ? "—" : amount(entry.amountCents)}</td><td class="mono">${amount(entry.balanceAfterCents)}</td></tr>`;
    }).join("") || '<tr><td colspan="6" class="empty-state">No postings on this account yet.</td></tr>';
    $("#statement-panel").classList.remove("hidden");
    $("#statement-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { toast(error.message, true); }
}

async function enterApplication() {
  $("#loading-state").classList.add("hidden");
  $("#login-view").classList.add("hidden");
  $("#application").classList.remove("hidden");
  await loadData();
  $("#application [data-open-transfer]").classList.toggle("hidden", state.user.role === "auditor");
}

async function initialize() {
  $("#today-label").textContent = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date());
  try {
    const { body } = await api("/api/me");
    state.user = body.user;
    state.csrf = body.csrfToken;
    await enterApplication();
  } catch {
    $("#loading-state").classList.add("hidden");
    $("#login-view").classList.remove("hidden");
  }
}

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#login-error").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    const { body } = await api("/api/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    state.user = body.user;
    state.csrf = body.csrfToken;
    await enterApplication();
  } catch (error) { $("#login-error").textContent = error.message; }
});

$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch { /* The local view still signs out if the session already expired. */ }
  location.reload();
});

document.addEventListener("click", event => {
  const nav = event.target.closest("[data-view]");
  if (nav) showView(nav.dataset.view);
  if (event.target.closest("[data-open-transfer]")) {
    if (!state.accounts.length) return toast("Create an account before moving money.", true);
    setMovementType("transfer");
    $("#movement-dialog").showModal();
  }
  const account = event.target.closest("[data-account-id]");
  if (account) loadStatement(account.dataset.accountId);
  if (event.target.closest("#create-account-open")) $("#create-account-form").classList.remove("hidden");
  if (event.target.closest("#create-account-cancel")) $("#create-account-form").classList.add("hidden");
  if (event.target.closest("#create-user-open")) $("#create-user-form").classList.remove("hidden");
  if (event.target.closest("#create-user-cancel")) $("#create-user-form").classList.add("hidden");
  if (event.target.closest("#close-statement")) $("#statement-panel").classList.add("hidden");
  const typeButton = event.target.closest("[data-type]");
  if (typeButton) setMovementType(typeButton.dataset.type);
});

document.addEventListener("keydown", event => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-account-id]")) {
    event.preventDefault();
    loadStatement(event.target.dataset.accountId);
  }
});

function setMovementType(type) {
  state.movementType = type;
  $("#movement-form").elements.type.value = type;
  $$(".movement-tab").forEach(button => button.classList.toggle("active", button.dataset.type === type));
  $("#source-label").classList.toggle("hidden", type === "deposit");
  $("#destination-label").classList.toggle("hidden", type === "withdrawal");
  const source = $("#movement-source");
  const destination = $("#movement-destination");
  if (type === "transfer") destination.disabled = false;
  if (type === "deposit") destination.disabled = false;
  if (type === "withdrawal") source.disabled = false;
}

$("#movement-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#movement-error").textContent = "";
  const form = new FormData(event.currentTarget);
  const type = form.get("type");
  const rawAmount = String(form.get("amount")).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(rawAmount)) {
    $("#movement-error").textContent = "Enter a positive amount with up to two decimal places.";
    return;
  }
  const amountCents = Math.round(Number(rawAmount) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    $("#movement-error").textContent = "Amount must be greater than zero.";
    return;
  }
  const movement = {
    type, amountCents, description: form.get("description"),
    ...(type !== "deposit" ? { fromAccountId: form.get("fromAccountId") } : {}),
    ...(type !== "withdrawal" ? { toAccountId: form.get("toAccountId") } : {})
  };
  const pendingId = `ledgerline.pending.${JSON.stringify(movement)}`;
  let key = sessionStorage.getItem(pendingId);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(pendingId, key);
  }
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const { body, response } = await api("/api/movements", { method: "POST", body: JSON.stringify({ ...movement, clientKey: key }) });
    sessionStorage.removeItem(pendingId);
    $("#movement-dialog").close();
    event.currentTarget.reset();
    await loadData();
    toast(response.headers.get("Idempotency-Replayed") ? "This request was already processed. The original result was returned." : `Movement posted · ${amount(body.amountCents)}`);
  } catch (error) {
    $("#movement-error").textContent = error.message;
    if (error.status && error.status < 500) sessionStorage.removeItem(pendingId);
  } finally { submitButton.disabled = false; }
});

$("#create-account-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = { name: form.get("name") };
  if (state.user.role === "administrator") payload.ownerUserId = form.get("ownerUserId");
  try {
    await api("/api/accounts", { method: "POST", body: JSON.stringify(payload) });
    event.currentTarget.reset();
    event.currentTarget.classList.add("hidden");
    await loadData();
    toast("Account created with a zero balance.");
  } catch (error) { toast(error.message, true); }
});

$("#create-user-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/users", { method: "POST", body: JSON.stringify({
      displayName: form.get("displayName"), username: form.get("username"),
      password: form.get("password"), role: form.get("role")
    }) });
    event.currentTarget.reset();
    event.currentTarget.classList.add("hidden");
    await loadData();
    toast("User created. Share the temporary password securely.");
  } catch (error) { toast(error.message, true); }
});

initialize().catch(error => {
  $("#loading-state").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  toast(error.message, true);
});
