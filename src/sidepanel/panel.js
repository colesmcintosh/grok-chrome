const state = {
  settings: {
    hasApiKey: false,
    model: "grok-4.3",
    maxSteps: 6,
    privacy: {
      redactSensitiveText: true,
      allowedHosts: [],
      blockedHosts: []
    }
  },
  activeTab: null,
  messages: [],
  pending: null,
  busy: false
};

const elements = {
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsPanel: document.querySelector("#settingsPanel"),
  settingsForm: document.querySelector("#settingsForm"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  modelInput: document.querySelector("#modelInput"),
  maxStepsInput: document.querySelector("#maxStepsInput"),
  redactionInput: document.querySelector("#redactionInput"),
  allowedHostsInput: document.querySelector("#allowedHostsInput"),
  blockedHostsInput: document.querySelector("#blockedHostsInput"),
  snapshotPreviewButton: document.querySelector("#snapshotPreviewButton"),
  snapshotPreview: document.querySelector("#snapshotPreview"),
  clearKeyButton: document.querySelector("#clearKeyButton"),
  setupView: document.querySelector("#setupView"),
  setupForm: document.querySelector("#setupForm"),
  setupApiKeyInput: document.querySelector("#setupApiKeyInput"),
  chatView: document.querySelector("#chatView"),
  tabMeta: document.querySelector("#tabMeta"),
  keyStatus: document.querySelector("#keyStatus"),
  modelStatus: document.querySelector("#modelStatus"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  promptInput: document.querySelector("#promptInput"),
  sendButton: document.querySelector("#sendButton"),
  messageTemplate: document.querySelector("#messageTemplate"),
  approvalTemplate: document.querySelector("#approvalTemplate")
};

init().catch((error) => {
  pushMessage("system", error.message || String(error));
  render();
});

async function init() {
  wireEvents();
  await refreshSettings();
  await refreshActiveTab();
  render();
}

function wireEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    elements.settingsPanel.hidden = !elements.settingsPanel.hidden;
  });

  elements.setupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = elements.setupApiKeyInput.value.trim();
    if (!apiKey) {
      return;
    }
    await saveSettings({ apiKey });
    elements.setupApiKeyInput.value = "";
  });

  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveSettings({
      apiKey: elements.apiKeyInput.value.trim(),
      model: elements.modelInput.value.trim(),
      maxSteps: Number(elements.maxStepsInput.value),
      redactSensitiveText: elements.redactionInput.checked,
      allowedHosts: elements.allowedHostsInput.value,
      blockedHosts: elements.blockedHostsInput.value
    });
    elements.apiKeyInput.value = "";
    elements.settingsPanel.hidden = true;
  });

  elements.snapshotPreviewButton.addEventListener("click", previewSnapshot);

  elements.clearKeyButton.addEventListener("click", async () => {
    setBusy(true);
    try {
      const response = await sendRuntime({ type: "settings:clearApiKey" });
      state.settings = publicSettings(response);
      state.pending = null;
    } catch (error) {
      pushMessage("system", error.message || String(error));
    } finally {
      setBusy(false);
      render();
    }
  });

  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendPrompt();
  });

  elements.promptInput.addEventListener("input", () => {
    elements.promptInput.style.height = "auto";
    elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 130)}px`;
  });

  elements.promptInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await sendPrompt();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshActiveTab().then(render).catch(() => {});
    }
  });
}

async function refreshSettings() {
  const response = await sendRuntime({ type: "settings:get" });
  state.settings = publicSettings(response);
}

async function refreshActiveTab() {
  const response = await sendRuntime({ type: "tabs:getActive" });
  state.activeTab = response.tab || null;
}

async function saveSettings(values) {
  setBusy(true);
  try {
    const response = await sendRuntime({ type: "settings:save", ...values });
    state.settings = publicSettings(response);
  } catch (error) {
    pushMessage("system", error.message || String(error));
  } finally {
    setBusy(false);
    render();
  }
}

async function previewSnapshot() {
  setBusy(true);
  document.body.classList.add("is-busy");

  try {
    await refreshActiveTab();
    if (!state.activeTab?.id) {
      throw new Error("No active tab is available.");
    }

    const response = await sendRuntime({
      type: "privacy:previewSnapshot",
      tabId: state.activeTab.id,
      privacy: formPrivacySettings()
    });
    renderSnapshotPreview(response.snapshot);
  } catch (error) {
    elements.snapshotPreview.hidden = false;
    elements.snapshotPreview.textContent = error.message || String(error);
  } finally {
    setBusy(false);
    document.body.classList.remove("is-busy");
  }
}

async function sendPrompt() {
  const prompt = elements.promptInput.value.trim();
  if (!prompt || state.busy || state.pending) {
    return;
  }

  if (!state.settings.hasApiKey) {
    elements.setupView.hidden = false;
    elements.setupApiKeyInput.focus();
    return;
  }

  await refreshActiveTab();
  if (!state.activeTab?.id) {
    pushMessage("system", "No active tab is available.");
    render();
    return;
  }

  elements.promptInput.value = "";
  elements.promptInput.style.height = "auto";
  pushMessage("user", prompt);
  setBusy(true);
  render();

  try {
    const response = await sendRuntime({
      type: "agent:start",
      tabId: state.activeTab.id,
      history: state.messages
    });
    handleAgentResponse(response);
  } catch (error) {
    pushMessage("system", error.message || String(error));
  } finally {
    setBusy(false);
    render();
  }
}

async function approvePending() {
  if (!state.pending || state.busy) {
    return;
  }

  setBusy(true);
  render();

  try {
    const response = await sendRuntime({
      type: "agent:approve",
      runId: state.pending.runId
    });
    state.pending = null;
    addFailedObservationMessages(response.observations);
    handleAgentResponse(response);
  } catch (error) {
    state.pending = null;
    pushMessage("system", error.message || String(error));
  } finally {
    setBusy(false);
    render();
  }
}

async function cancelPending() {
  if (!state.pending) {
    return;
  }

  const runId = state.pending.runId;
  state.pending = null;
  pushMessage("system", "Action batch cancelled.");
  render();
  await sendRuntime({ type: "agent:cancel", runId }).catch(() => {});
}

function handleAgentResponse(response) {
  if (response.status === "needs_approval") {
    state.pending = {
      runId: response.runId,
      actions: response.actions || []
    };
    return;
  }

  if (response.assistant?.content) {
    pushMessage("assistant", response.assistant.content);
  }

  if (response.status === "needs_user") {
    state.pending = null;
  }
}

function addFailedObservationMessages(observations) {
  const fresh = Array.isArray(observations) ? observations.slice(-4) : [];
  for (const observation of fresh) {
    if (!observation || observation.ok || observation.tool === "ask_user") {
      continue;
    }
    pushMessage("system", `${observation.tool} failed: ${observation.summary}`);
  }
}

function pushMessage(role, content) {
  state.messages.push({
    role,
    content: String(content || "").trim()
  });
}

function render() {
  const hasKey = state.settings.hasApiKey;
  elements.setupView.hidden = hasKey;
  elements.chatView.hidden = !hasKey;
  elements.keyStatus.textContent = hasKey ? "Key saved" : "Key missing";
  elements.modelStatus.textContent = state.settings.model;
  elements.modelInput.value = state.settings.model;
  elements.maxStepsInput.value = state.settings.maxSteps;
  elements.redactionInput.checked = state.settings.privacy.redactSensitiveText;
  elements.allowedHostsInput.value = state.settings.privacy.allowedHosts.join("\n");
  elements.blockedHostsInput.value = state.settings.privacy.blockedHosts.join("\n");
  elements.tabMeta.textContent = formatTab(state.activeTab);
  document.body.classList.toggle("is-busy", state.busy);

  renderMessages();

  const disableComposer = state.busy || Boolean(state.pending);
  elements.promptInput.disabled = disableComposer;
  elements.sendButton.disabled = disableComposer;

  if (hasKey && !disableComposer) {
    setTimeout(() => elements.promptInput.focus(), 0);
  }
}

function renderMessages() {
  elements.messages.textContent = "";

  if (state.messages.length === 0) {
    const intro = elements.messageTemplate.content.firstElementChild.cloneNode(true);
    intro.classList.add("assistant");
    intro.querySelector(".message-role").textContent = "Grok";
    intro.querySelector(".message-body").textContent = "Ready on this tab.";
    elements.messages.append(intro);
  }

  for (const message of state.messages) {
    const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role);
    node.querySelector(".message-role").textContent = roleLabel(message.role);
    node.querySelector(".message-body").textContent = message.content;
    elements.messages.append(node);
  }

  if (state.pending) {
    elements.messages.append(renderApproval(state.pending));
  }

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderApproval(pending) {
  const node = elements.approvalTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".approval-count").textContent = `${pending.actions.length}`;
  const list = node.querySelector(".approval-actions");

  pending.actions.forEach((action, index) => {
    const row = document.createElement("div");
    row.className = "action-row";

    const number = document.createElement("div");
    number.className = "action-index";
    number.textContent = String(index + 1);

    const summary = document.createElement("div");
    summary.className = "action-summary";
    summary.textContent = action.summary || action.tool;

    row.append(number, summary);
    list.append(row);
  });

  node.querySelector(".approve-action").addEventListener("click", approvePending);
  node.querySelector(".cancel-action").addEventListener("click", cancelPending);
  return node;
}

function setBusy(isBusy) {
  state.busy = isBusy;
}

function roleLabel(role) {
  if (role === "user") {
    return "You";
  }
  if (role === "assistant") {
    return "Grok";
  }
  return "Event";
}

function formatTab(tab) {
  if (!tab) {
    return "No active tab";
  }

  try {
    const url = new URL(tab.url || "");
    return url.hostname || tab.title || "Active tab";
  } catch {
    return tab.title || "Active tab";
  }
}

function publicSettings(response) {
  return {
    hasApiKey: Boolean(response.hasApiKey),
    model: response.model || "grok-4.3",
    maxSteps: Number(response.maxSteps) || 6,
    privacy: {
      redactSensitiveText: response.privacy?.redactSensitiveText !== false,
      allowedHosts: Array.isArray(response.privacy?.allowedHosts)
        ? response.privacy.allowedHosts
        : [],
      blockedHosts: Array.isArray(response.privacy?.blockedHosts)
        ? response.privacy.blockedHosts
        : []
    }
  };
}

function formPrivacySettings() {
  return {
    redactSensitiveText: elements.redactionInput.checked,
    allowedHosts: elements.allowedHostsInput.value,
    blockedHosts: elements.blockedHostsInput.value
  };
}

function renderSnapshotPreview(snapshot) {
  if (!snapshot) {
    elements.snapshotPreview.hidden = true;
    elements.snapshotPreview.textContent = "";
    return;
  }

  elements.snapshotPreview.hidden = false;
  elements.snapshotPreview.textContent = [
    snapshot.title || "Untitled",
    snapshot.url || "unknown URL",
    `${snapshot.headingCount || 0} headings, ${snapshot.elementCount || 0} interactive elements`,
    "",
    String(snapshot.text || "(no visible text captured)").slice(0, 1200)
  ].join("\n");
}

function sendRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "Extension request failed."));
        return;
      }

      resolve(response);
    });
  });
}
