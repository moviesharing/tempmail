import DOMPurify from "dompurify";
import QRCode from "qrcode";

const root = document.querySelector("#mailbox-root");
if (root) {
  const addressOutput = document.querySelector("#mailbox-address");
  const statusOutput = document.querySelector("#mailbox-status");
  const expiryOutput = document.querySelector("#expiry-status");
  const errorOutput = document.querySelector("#mailbox-error");
  const messageList = document.querySelector("#message-list");
  const reader = document.querySelector("#message-reader");
  const countOutput = document.querySelector("#message-count");
  const updatedOutput = document.querySelector("#last-updated");
  const copyButton = document.querySelector("#copy-address");
  const newButton = document.querySelector("#new-address");
  const refreshButton = document.querySelector("#refresh-inbox");
  const extendButton = document.querySelector("#extend-address");
  const changeForm = document.querySelector("#change-address-form");
  const changeButton = document.querySelector("#change-address");
  const qrDialog = document.querySelector("#qr-dialog");
  const pollEveryMs = 30_000;
  let requestQueue = Promise.resolve();

  const state = {
    address: "",
    timestamp: 0,
    messages: [],
    selectedId: null,
    busy: false,
    active: false,
    polling: false,
    timer: 0,
  };

  function setStatus(label, tone = "neutral") {
    statusOutput.replaceChildren();
    const dot = document.createElement("span");
    statusOutput.append(dot, document.createTextNode(label));
    statusOutput.dataset.tone = tone;
  }

  function showError(message) {
    errorOutput.textContent = message;
    errorOutput.hidden = false;
    setStatus("Connection issue", "error");
  }

  function clearError() {
    errorOutput.textContent = "";
    errorOutput.hidden = true;
  }

  function updateButtons() {
    const ready = Boolean(state.address) && !state.busy;
    copyButton.disabled = !ready;
    document.querySelector("#show-qr").disabled = !ready;
    refreshButton.disabled = !ready || !state.active;
    extendButton.disabled = !ready || !state.active;
    changeButton.disabled = !ready || !state.active;
    newButton.disabled = state.busy;
    root.setAttribute("aria-busy", String(state.busy));
  }

  function saveMailbox() {
    try {
      localStorage.setItem("tempmail-mailbox", JSON.stringify({
        address: state.address,
        timestamp: state.timestamp,
      }));
    } catch {
      // The HttpOnly provider cookie still restores the server session.
    }
  }

  function decodeEntities(value) {
    const parser = new DOMParser();
    return parser.parseFromString(value, "text/html").documentElement.textContent || "";
  }

  function setAddress(payload) {
    state.address = payload.email;
    state.timestamp = payload.timestamp;
    addressOutput.textContent = payload.email;
    state.active = true;
    state.messages = [];
    state.selectedId = null;
    saveMailbox();
    renderMessages();
    renderEmptyReader();
    setStatus("Mailbox ready", "success");
    updateExpiry();
    updatedOutput.textContent = "Messages refresh automatically every 30 seconds.";
  }

  function updateExpiry() {
    if (!state.timestamp) return;
    const remaining = Math.max(0, state.timestamp * 1000 + 60 * 60 * 1000 - Date.now());
    if (remaining === 0) {
      expiryOutput.textContent = "This address may have expired.";
      return;
    }
    const minutes = Math.ceil(remaining / 60_000);
    expiryOutput.textContent = `Address time remaining: about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }

  function request(action, values = {}) {
    const perform = async () => {
      const response = await fetch("/api/mailbox", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...values }),
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("The mailbox service returned an unreadable response.");
      }
      if (!response.ok) {
        const error = new Error(data.error || "The mailbox request failed.");
        error.status = response.status;
        throw error;
      }
      return data;
    };
    const queued = requestQueue.then(perform, perform);
    requestQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  function normalizeMessage(message) {
    const id = Number(message.mail_id);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return {
      id,
      sender: decodeEntities(String(message.mail_from || "Unknown sender")),
      subject: decodeEntities(String(message.mail_subject || "(no subject)")),
      excerpt: decodeEntities(String(message.mail_excerpt || "")),
      timestamp: Number(message.mail_timestamp) || 0,
      date: String(message.mail_date || ""),
      read: Number(message.mail_read) === 1,
    };
  }

  function formatDate(timestamp, date) {
    if (timestamp > 0) {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(timestamp * 1000));
    }
    return date || "Date unavailable";
  }

  function renderMessages() {
    messageList.replaceChildren();
    countOutput.textContent = String(state.messages.length);
    if (!state.messages.length) {
      const empty = document.createElement("div");
      empty.className = "inbox-empty";
      empty.setAttribute("role", "status");
      empty.textContent = state.active
        ? "Your inbox is empty. Leave this page open and new messages will appear here."
        : "Connect to the mailbox to view messages.";
      messageList.append(empty);
      return;
    }

    for (const message of state.messages) {
      const item = document.createElement("div");
      item.className = "message-item";
      item.setAttribute("role", "listitem");
      const select = document.createElement("button");
      select.type = "button";
      select.className = "message-select";
      select.dataset.messageId = String(message.id);
      select.setAttribute("aria-label", `${message.read ? "Read" : "Unread"} message from ${message.sender}: ${message.subject}`);
      if (!message.read) select.classList.add("message-unread");
      if (message.id === state.selectedId) select.classList.add("message-selected");

      const details = document.createElement("span");
      details.className = "message-details";
      const sender = document.createElement("strong");
      sender.textContent = message.sender;
      const unread = document.createElement("span");
      unread.className = "unread-label";
      unread.textContent = message.read ? "" : "New";
      const subject = document.createElement("span");
      subject.className = "message-subject";
      subject.textContent = message.subject;
      const excerpt = document.createElement("span");
      excerpt.className = "message-excerpt";
      excerpt.textContent = message.excerpt || "Open to read this message.";
      details.append(sender, unread, subject, excerpt);

      const meta = document.createElement("span");
      meta.className = "message-meta";
      const date = document.createElement("time");
      date.textContent = formatDate(message.timestamp, message.date);
      if (message.timestamp) date.dateTime = new Date(message.timestamp * 1000).toISOString();
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "message-delete";
      remove.dataset.deleteId = String(message.id);
      remove.setAttribute("aria-label", `Delete message from ${message.sender}`);
      remove.textContent = "Delete";
      meta.append(date);
      select.append(details, meta);
      item.append(select, remove);
      messageList.append(item);
    }
  }

  function renderEmptyReader() {
    reader.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "reader-empty";
    const glyph = document.createElement("span");
    glyph.className = "reader-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "↳";
    const title = document.createElement("h3");
    title.textContent = "Select a message";
    const description = document.createElement("p");
    description.textContent = "Choose an email from your inbox to read it here.";
    empty.append(glyph, title, description);
    reader.append(empty);
  }

  function textVersion(html) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    parsed.querySelectorAll("script,style,svg,iframe,object,embed").forEach((node) => node.remove());
    return parsed.body.textContent?.trim() || "";
  }

  function safeEmailDocument(html) {
    const clean = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["base", "form", "iframe", "object", "embed", "script", "style", "link", "meta"],
      FORBID_ATTR: ["style", "srcset", "target"],
    });
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:15px/1.65 system-ui,sans-serif;color:#202b2a;margin:1.25rem;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{padding:.35rem;border:1px solid #bbb}</style></head><body>${clean}</body></html>`;
  }

  async function openMessage(id) {
    state.selectedId = id;
    renderMessages();
    clearError();
    reader.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "reader-loading";
    loading.textContent = "Loading message…";
    reader.append(loading);
    try {
      const mail = await request("fetch", { id });
      if (state.selectedId !== id) return;
      const message = state.messages.find((item) => item.id === id);
      const subject = decodeEntities(String(mail.mail_subject || message?.subject || "(no subject)"));
      const from = decodeEntities(String(mail.mail_from || message?.sender || "Unknown sender"));
      const to = decodeEntities(String(mail.mail_to || mail.mail_recipient || state.address));
      const html = String(mail.mail_body || mail.mail_html || mail.body_html || mail.body || "");
      const plain = String(mail.mail_body_plain || mail.mail_text || mail.body_text || "");
      const plainValue = plain || textVersion(html);

      reader.replaceChildren();
      const header = document.createElement("header");
      header.className = "reader-header";
      const title = document.createElement("h3");
      title.textContent = subject;
      const fields = document.createElement("dl");
      fields.className = "reader-fields";
      for (const [label, value] of [
        ["From", from],
        ["To", to],
        ["Date", formatDate(Number(mail.mail_timestamp) || message?.timestamp || 0, String(mail.mail_date || message?.date || ""))],
      ]) {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        row.append(term, detail);
        fields.append(row);
      }
      header.append(title, fields);

      const tabs = document.createElement("div");
      tabs.className = "reader-tabs";
      tabs.setAttribute("role", "tablist");
      const htmlTab = document.createElement("button");
      htmlTab.type = "button";
      htmlTab.setAttribute("role", "tab");
      htmlTab.textContent = "Formatted";
      htmlTab.setAttribute("aria-selected", "true");
      const textTab = document.createElement("button");
      textTab.type = "button";
      textTab.setAttribute("role", "tab");
      textTab.textContent = "Plain text";
      textTab.setAttribute("aria-selected", "false");
      const body = document.createElement("div");
      body.className = "reader-body";
      body.setAttribute("role", "tabpanel");
      const frame = document.createElement("iframe");
      frame.className = "email-frame";
      frame.title = `Email content: ${subject}`;
      frame.setAttribute("sandbox", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = safeEmailDocument(html || `<p>${DOMPurify.sanitize(plainValue)}</p>`);
      const pre = document.createElement("pre");
      pre.className = "email-plain";
      pre.textContent = plainValue || "No plain-text version was included.";
      pre.hidden = true;
      body.append(frame, pre);
      htmlTab.addEventListener("click", () => {
        frame.hidden = false;
        pre.hidden = true;
        htmlTab.setAttribute("aria-selected", "true");
        textTab.setAttribute("aria-selected", "false");
      });
      textTab.addEventListener("click", () => {
        frame.hidden = true;
        pre.hidden = false;
        htmlTab.setAttribute("aria-selected", "false");
        textTab.setAttribute("aria-selected", "true");
      });
      tabs.append(htmlTab, textTab);
      reader.append(header, tabs, body);
      if (message) message.read = true;
      renderMessages();
    } catch (error) {
      reader.replaceChildren();
      renderEmptyReader();
      showError(error.message);
      if (error.status === 401) state.active = false;
      updateButtons();
    }
  }

  async function loadMessages(action = "list") {
    if (!state.active || state.polling) return;
    state.polling = true;
    try {
      const oldest = state.messages.length
        ? Math.min(...state.messages.map((message) => message.id))
        : 0;
      const data = await request(action, action === "check" ? { seq: oldest } : { offset: 0 });
      if (data.email && data.email !== state.address) {
        state.active = false;
        throw Object.assign(new Error("This provider session now points to a different address. Start a new address to continue."), { status: 401 });
      }
      const incoming = data.messages.map(normalizeMessage).filter(Boolean);
      const combined = new Map(state.messages.map((message) => [message.id, message]));
      for (const message of incoming) {
        const previous = combined.get(message.id);
        combined.set(message.id, previous ? { ...previous, ...message, read: previous.read || message.read } : message);
      }
      state.messages = [...combined.values()]
        .sort((left, right) => right.timestamp - left.timestamp || right.id - left.id)
        .slice(0, 20);
      renderMessages();
      updatedOutput.textContent = `Last checked ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date())}.`;
      setStatus("Mailbox ready", "success");
      clearError();
      if (state.selectedId && incoming.some((message) => message.id === state.selectedId)) {
        await openMessage(state.selectedId);
      }
    } catch (error) {
      showError(error.message);
      if (error.status === 401) {
        state.active = false;
        stopPolling();
      }
    } finally {
      state.polling = false;
      updateButtons();
    }
  }

  function startPolling() {
    stopPolling();
    state.timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadMessages("check");
      updateExpiry();
    }, pollEveryMs);
  }

  function stopPolling() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = 0;
  }

  async function runAction(action, values = {}) {
    if (state.busy) return null;
    state.busy = true;
    updateButtons();
    clearError();
    try {
      return await request(action, values);
    } catch (error) {
      showError(error.message);
      if (error.status === 401) {
        state.active = false;
        stopPolling();
      }
      return null;
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  async function connect() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem("tempmail-mailbox") || "null");
    } catch {
      saved = null;
    }
    if (saved?.address) {
      addressOutput.textContent = saved.address;
      setStatus("Restoring session", "neutral");
    }

    const data = await runAction("init");
    if (!data) {
      if (saved?.address) {
        state.address = saved.address;
        state.timestamp = Number(saved.timestamp) || 0;
        addressOutput.textContent = saved.address;
      } else {
        addressOutput.textContent = "Unable to connect";
      }
      root.setAttribute("aria-busy", "false");
      updateButtons();
      return;
    }
    setAddress(data);
    await loadMessages("list");
    startPolling();
    updateButtons();
  }

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.address);
      setStatus("Address copied", "success");
      window.setTimeout(() => setStatus(state.active ? "Mailbox ready" : "Session expired", state.active ? "success" : "error"), 1800);
    } catch {
      showError("Clipboard access is unavailable. Select and copy the address manually.");
    }
  });

  newButton.addEventListener("click", async () => {
    const data = await runAction("new", state.address ? { email: state.address } : {});
    if (!data) return;
    setAddress(data);
    await loadMessages("list");
    startPolling();
  });

  refreshButton.addEventListener("click", () => loadMessages("check"));
  messageList.addEventListener("click", async (event) => {
    const deleteTarget = event.target.closest("[data-delete-id]");
    if (deleteTarget) {
      event.stopPropagation();
      const id = Number(deleteTarget.dataset.deleteId);
      const result = await runAction("delete", { ids: [id] });
      if (result) {
        state.messages = state.messages.filter((message) => !result.deletedIds.includes(message.id));
        if (state.selectedId === id) {
          state.selectedId = null;
          renderEmptyReader();
        }
        renderMessages();
      }
      return;
    }
    const messageTarget = event.target.closest("[data-message-id]");
    if (messageTarget) openMessage(Number(messageTarget.dataset.messageId));
  });

  extendButton.addEventListener("click", async () => {
    const result = await runAction("extend");
    if (!result) return;
    if (Number(result.affected) > 0 && Number(result.email_timestamp) > 0) {
      state.timestamp = Number(result.email_timestamp);
      saveMailbox();
      updateExpiry();
      setStatus("Address extended", "success");
    } else {
      showError("The provider could not extend this address.");
    }
  });

  changeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = new FormData(changeForm).get("user");
    const data = await runAction("change", { user });
    if (!data) return;
    setAddress(data);
    await loadMessages("list");
    startPolling();
  });

  document.querySelector("#show-qr").addEventListener("click", async () => {
    try {
      const dataUrl = await QRCode.toDataURL(state.address, {
        width: 220,
        margin: 2,
        color: { dark: "#102a2a", light: "#ffffff" },
      });
      document.querySelector("#qr-image").src = dataUrl;
      document.querySelector("#qr-address").textContent = state.address;
      qrDialog.showModal();
    } catch {
      showError("The address QR code could not be generated.");
    }
  });
  document.querySelector("#close-qr").addEventListener("click", () => qrDialog.close());
  qrDialog.addEventListener("click", (event) => {
    if (event.target === qrDialog) qrDialog.close();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.active) loadMessages("check");
  });

  connect();
}
