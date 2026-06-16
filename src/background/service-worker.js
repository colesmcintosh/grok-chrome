import { createXai } from "@ai-sdk/xai";
import { generateText, Output } from "ai";

import {
  normalizeMaxSteps,
  normalizeNavigationUrl
} from "../shared/browser-policy.js";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL,
  buildGrokMessages,
  normalizeActions,
  parseAssistantPayload,
  summarizeAction
} from "../shared/agent-protocol.js";

const STORAGE_KEYS = {
  apiKey: "xaiApiKey",
  model: "xaiModel",
  maxSteps: "agentMaxSteps"
};
const RUN_SESSION_PREFIX = "grokPendingRun:";
const RUN_INDEX_SESSION_KEY = "grokPendingRunIndex";
const PANEL_STATE_PREFIX = "grokPanelState:";
const AGENT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: {
      type: "string",
      description: "A short user-facing update or final answer."
    },
    actions: {
      type: "array",
      description: "Browser actions to request approval for. Empty when no action is needed.",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool: {
            type: "string",
            enum: ["navigate", "click", "type", "select", "scroll", "wait", "ask_user"]
          },
          args: {
            type: "object",
            additionalProperties: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
                {
                  type: "array",
                  items: {
                    anyOf: [
                      { type: "string" },
                      { type: "number" },
                      { type: "boolean" }
                    ]
                  }
                }
              ]
            }
          }
        },
        required: ["tool", "args"]
      }
    }
  },
  required: ["message", "actions"]
};

const runs = new Map();

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open && tab.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "settings:get":
      return getPublicSettings();
    case "settings:save":
      return saveSettings(message);
    case "settings:clearApiKey":
      await storageRemove(STORAGE_KEYS.apiKey);
      return getPublicSettings();
    case "tabs:getActive":
      return { tab: await getActiveTab() };
    case "panel:getState":
      return getPanelState(message);
    case "panel:saveState":
      await savePanelState(message);
      return {};
    case "agent:getPending":
      return getPendingRun(message);
    case "agent:start":
      return startRun(message);
    case "agent:approve":
      return approveRun(message);
    case "agent:cancel":
      await deleteRun(message.runId);
      return { status: "cancelled" };
    default:
      throw new Error("Unsupported message type.");
  }
}

async function getPublicSettings() {
  const values = await storageGet([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.model,
    STORAGE_KEYS.maxSteps
  ]);

  return {
    hasApiKey: Boolean(values[STORAGE_KEYS.apiKey]),
    model: values[STORAGE_KEYS.model] || DEFAULT_MODEL,
    maxSteps: normalizeMaxSteps(values[STORAGE_KEYS.maxSteps], DEFAULT_MAX_STEPS)
  };
}

async function getPrivateSettings() {
  const values = await storageGet([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.model,
    STORAGE_KEYS.maxSteps
  ]);
  const apiKey = values[STORAGE_KEYS.apiKey];
  if (!apiKey) {
    throw new Error("Add an xAI API key before starting a chat.");
  }

  return {
    apiKey,
    model: values[STORAGE_KEYS.model] || DEFAULT_MODEL,
    maxSteps: normalizeMaxSteps(values[STORAGE_KEYS.maxSteps], DEFAULT_MAX_STEPS)
  };
}

async function saveSettings(message) {
  const updates = {};

  if (typeof message.apiKey === "string" && message.apiKey.trim()) {
    const apiKey = message.apiKey.trim();
    if (apiKey.length < 16) {
      throw new Error("The API key looks too short.");
    }
    updates[STORAGE_KEYS.apiKey] = apiKey;
  }

  if (typeof message.model === "string" && message.model.trim()) {
    updates[STORAGE_KEYS.model] = message.model.trim();
  }

  if (message.maxSteps != null) {
    updates[STORAGE_KEYS.maxSteps] = normalizeMaxSteps(message.maxSteps, DEFAULT_MAX_STEPS);
  }

  if (Object.keys(updates).length) {
    await storageSet(updates);
  }

  return getPublicSettings();
}

async function startRun(message) {
  const settings = await getPrivateSettings();
  const tab = await resolveTab(message.tabId);
  const run = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    history: Array.isArray(message.history) ? message.history : [],
    observations: [],
    settings,
    stepCount: 0,
    pendingActions: []
  };

  runs.set(run.id, run);
  return continueRun(run);
}

async function getPendingRun(message) {
  const tab = await resolveTab(message.tabId);
  const index = await getRunIndex();
  const runId = index[String(tab.id)];
  if (!runId) {
    return { pending: null };
  }

  const run = await getRun(runId).catch(() => null);
  if (!run?.pendingActions?.length) {
    await removeRunIndex(runId);
    return { pending: null };
  }

  return {
    pending: {
      runId: run.id,
      actions: run.pendingActions.map((action) => ({
        ...action,
        summary: summarizeActionWithSnapshot(action, run.lastSnapshot)
      }))
    }
  };
}

async function approveRun(message) {
  const run = await getRun(message.runId);
  if (!run) {
    throw new Error("That pending run is no longer available.");
  }

  const actions = Array.isArray(run.pendingActions) ? run.pendingActions : [];
  run.pendingActions = [];

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const observation = await executeAction(run.tabId, action, run.lastSnapshot);
    run.observations.push(observation);

    if (action.tool === "ask_user") {
      await deleteRun(run.id);
      return {
        status: "needs_user",
        runId: run.id,
        assistant: {
          content: action.args?.question || "Manual input is needed before I can continue."
        },
        observations: [observation]
      };
    }

    if (observation.pageChanged && index < actions.length - 1) {
      break;
    }
  }

  return continueRun(run);
}

async function continueRun(run) {
  if (run.stepCount >= run.settings.maxSteps) {
    await deleteRun(run.id);
    return {
      status: "complete",
      runId: run.id,
      assistant: {
        content: "I stopped after reaching the configured action limit."
      },
      observations: run.observations
    };
  }

  run.stepCount += 1;
  const snapshot = await getSnapshot(run.tabId);
  run.lastSnapshot = snapshot;
  const messages = buildGrokMessages(run.history, snapshot, run.observations);
  const completion = await callGrok(run.settings, messages);
  const parsed = parseAssistantPayload(completion.content);

  if (parsed.actions.length > 0) {
    run.pendingActions = parsed.actions;
    runs.set(run.id, run);
    await persistRun(run);
    return {
      status: "needs_approval",
      runId: run.id,
      assistant: {
        content: parsed.message || "I need to use the browser."
      },
      actions: parsed.actions.map((action) => ({
        ...action,
        summary: summarizeActionWithSnapshot(action, snapshot)
      })),
      observations: run.observations,
      usage: completion.usage
    };
  }

  await deleteRun(run.id);
  return {
    status: "complete",
    runId: run.id,
    assistant: {
      content: parsed.message || completion.content
    },
    observations: run.observations,
    usage: completion.usage
  };
}

async function getRun(runId) {
  if (!runId) {
    return null;
  }

  const inMemory = runs.get(runId);
  if (inMemory) {
    return inMemory;
  }

  const stored = await sessionGet(runSessionKey(runId));
  const run = stored[runSessionKey(runId)];
  if (!run) {
    return null;
  }

  const settings = await getPrivateSettings();
  const restored = {
    ...run,
    settings: {
      ...settings,
      model: run.settings?.model || settings.model,
      maxSteps: run.settings?.maxSteps || settings.maxSteps
    }
  };
  runs.set(runId, restored);
  return restored;
}

async function persistRun(run) {
  if (!run?.id) {
    return;
  }

  const index = await getRunIndex();
  index[String(run.tabId)] = run.id;

  await sessionSet({
    [RUN_INDEX_SESSION_KEY]: index,
    [runSessionKey(run.id)]: {
      id: run.id,
      tabId: run.tabId,
      history: run.history,
      observations: run.observations,
      stepCount: run.stepCount,
      pendingActions: run.pendingActions,
      lastSnapshot: run.lastSnapshot,
      settings: {
        model: run.settings.model,
        maxSteps: run.settings.maxSteps
      }
    }
  });
}

async function deleteRun(runId) {
  if (!runId) {
    return;
  }

  runs.delete(runId);
  await sessionRemove(runSessionKey(runId));
  await removeRunIndex(runId);
}

function runSessionKey(runId) {
  return `${RUN_SESSION_PREFIX}${runId}`;
}

async function getRunIndex() {
  const stored = await sessionGet(RUN_INDEX_SESSION_KEY);
  const index = stored[RUN_INDEX_SESSION_KEY];
  return index && typeof index === "object" && !Array.isArray(index) ? index : {};
}

async function removeRunIndex(runId) {
  const index = await getRunIndex();
  let changed = false;

  for (const [tabId, indexedRunId] of Object.entries(index)) {
    if (indexedRunId === runId) {
      delete index[tabId];
      changed = true;
    }
  }

  if (changed) {
    await sessionSet({ [RUN_INDEX_SESSION_KEY]: index });
  }
}

async function getPanelState(message) {
  const tab = await resolveTab(message.tabId);
  const key = panelStateKey(tab.id);
  const stored = await sessionGet(key);
  return {
    messages: sanitizePanelMessages(stored[key]?.messages)
  };
}

async function savePanelState(message) {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) {
    return;
  }

  await sessionSet({
    [panelStateKey(tabId)]: {
      messages: sanitizePanelMessages(message.messages)
    }
  });
}

function panelStateKey(tabId) {
  return `${PANEL_STATE_PREFIX}${tabId}`;
}

function sanitizePanelMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter((message) => message && ["user", "assistant", "system"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content || "").trim().slice(0, 12000)
    }))
    .filter((message) => message.content)
    .slice(-64);
}

async function callGrok(settings, messages) {
  const provider = createXai({
    apiKey: settings.apiKey,
    fetch
  });

  try {
    const result = await generateText({
      model: provider(settings.model),
      messages,
      temperature: 0.2,
      output: Output.object({
        schema: AGENT_RESPONSE_SCHEMA,
        name: "browser_action_plan",
        description: "A browser-agent response with a user-facing message and zero or more browser actions."
      })
    });

    return {
      content: JSON.stringify({
        message: result.output?.message || "",
        actions: normalizeActions(result.output?.actions)
      }),
      usage: result.usage || null
    };
  } catch (error) {
    const fallback = await generateText({
      model: provider(settings.model),
      messages,
      temperature: 0.2
    }).catch((fallbackError) => {
      throw new Error(formatAiSdkError(fallbackError, error));
    });

    const parsed = parseAssistantPayload(fallback.text);
    return {
      content: JSON.stringify({
        message: parsed.message || fallback.text,
        actions: parsed.actions
      }),
      usage: fallback.usage || null
    };
  }
}

function formatAiSdkError(error, structuredError) {
  const primary = error?.message || String(error);
  const structured = structuredError?.message || String(structuredError);
  if (primary === structured) {
    return primary;
  }
  return `${primary}. Structured action planning also failed: ${structured}`;
}

async function executeAction(tabId, action, beforeSnapshot = null) {
  try {
    if (action.tool === "navigate") {
      const url = normalizeNavigationUrl(action.args?.url);
      await tabsUpdate(tabId, { url });
      await waitForTabLoad(tabId);
      return { ok: true, tool: "navigate", summary: `Opened ${url}`, pageChanged: true };
    }

    if (action.tool === "wait") {
      const ms = Math.max(250, Math.min(5000, Number(action.args?.ms) || 1000));
      await delay(ms);
      return { ok: true, tool: "wait", summary: `Waited ${ms} ms`, pageChanged: false };
    }

    if (action.tool === "ask_user") {
      return {
        ok: true,
        tool: "ask_user",
        summary: action.args?.question || "Asked the user for manual input.",
        pageChanged: false
      };
    }

    const loadPromise = actionMayChangePage(action)
      ? waitForTabLoadSignal(tabId, 3500)
      : Promise.resolve(false);
    const result = await sendPageTool(tabId, {
      type: "grok:perform",
      action
    });
    const settled = await waitForPageSettled(tabId, beforeSnapshot, loadPromise, action);
    const summary = [result?.summary || result?.error || "Action completed.", settled.summary]
      .filter(Boolean)
      .join(" ");

    return {
      ok: Boolean(result?.ok),
      tool: action.tool,
      summary,
      pageChanged: Boolean(settled.changed)
    };
  } catch (error) {
    return {
      ok: false,
      tool: action.tool,
      summary: error.message || String(error),
      pageChanged: false
    };
  }
}

function summarizeActionWithSnapshot(action, snapshot) {
  const element = findSnapshotElement(snapshot, action.args?.ref);
  const label = elementLabel(element);

  if (action.tool === "click" && label) {
    return `Click ${label}`;
  }
  if (action.tool === "type" && label) {
    return `Type into ${label}`;
  }
  if (action.tool === "select" && label) {
    return `Choose ${action.args?.value || "an option"} in ${label}`;
  }
  return summarizeAction(action);
}

function findSnapshotElement(snapshot, ref) {
  if (!snapshot?.elements || typeof ref !== "string") {
    return null;
  }
  return snapshot.elements.find((element) => element.ref === ref) || null;
}

function elementLabel(element) {
  if (!element) {
    return "";
  }
  return element.name || element.placeholder || element.title || element.href || "";
}

function actionMayChangePage(action) {
  if (action.tool === "click" || action.tool === "select") {
    return true;
  }
  return action.tool === "type" && Boolean(action.args?.submit);
}

async function waitForPageSettled(tabId, beforeSnapshot, loadPromise, action) {
  if (!actionMayChangePage(action)) {
    return { changed: false, summary: "" };
  }

  const beforeFingerprint = snapshotFingerprint(beforeSnapshot);
  const deadline = Date.now() + 3500;
  let loadObserved = false;

  while (Date.now() < deadline) {
    loadObserved = loadObserved || await Promise.race([
      loadPromise,
      delay(225).then(() => false)
    ]);

    const latest = await getSnapshot(tabId).catch(() => null);
    if (!latest) {
      continue;
    }

    if (!beforeFingerprint || snapshotFingerprint(latest) !== beforeFingerprint) {
      return {
        changed: true,
        summary: `Page changed to "${latest.title || "Untitled"}".`
      };
    }

    if (loadObserved) {
      return {
        changed: false,
        summary: "Page loaded, but the visible snapshot did not change."
      };
    }
  }

  return {
    changed: false,
    summary: "No visible page change detected yet."
  };
}

function snapshotFingerprint(snapshot) {
  if (!snapshot) {
    return "";
  }

  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements
        .slice(0, 20)
        .map((element) => `${element.ref}:${element.kind}:${element.name || ""}:${element.href || ""}`)
        .join("|")
    : "";

  return [
    snapshot.url || "",
    snapshot.title || "",
    String(snapshot.text || "").slice(0, 1200),
    elements
  ].join("\n");
}

async function getSnapshot(tabId) {
  try {
    const snapshot = await sendPageTool(tabId, { type: "grok:snapshot" });
    if (!snapshot?.ok) {
      throw new Error(snapshot?.error || "The page did not provide a snapshot.");
    }
    return snapshot.snapshot;
  } catch (error) {
    const tab = await tabsGet(tabId).catch(() => null);
    return {
      title: tab?.title || "Unavailable page",
      url: tab?.url || "",
      status: "limited",
      warnings: [error.message || String(error)],
      headings: [],
      elements: [],
      text: "The extension could not inspect this page. It may be a browser-internal page, a restricted Chrome Web Store page, or a page that needs to be reloaded after installing the extension."
    };
  }
}

async function sendPageTool(tabId, payload) {
  await ensureContentScript(tabId);
  return tabsSendMessage(tabId, payload);
}

async function ensureContentScript(tabId) {
  try {
    const response = await tabsSendMessage(tabId, { type: "grok:ping" });
    if (response?.ok) {
      return;
    }
  } catch {
    // Injection below handles tabs that were already open when the extension loaded.
  }

  await scriptingExecuteScript({
    target: { tabId },
    files: ["src/content/page-tools.js"]
  });
}

async function resolveTab(tabId) {
  if (Number.isInteger(tabId)) {
    return tabsGet(tabId);
  }
  return getActiveTab();
}

async function getActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }
  return tab;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(cleanup, 10000);

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function waitForTabLoadSignal(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => cleanup(false), timeoutMs);

    function cleanup(didLoad) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(didLoad);
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup(true);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function sessionGet(key) {
  if (!chrome.storage.session) {
    return Promise.resolve({});
  }

  return new Promise((resolve, reject) => {
    chrome.storage.session.get(key, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function sessionSet(values) {
  if (!chrome.storage.session) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    chrome.storage.session.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function sessionRemove(key) {
  if (!chrome.storage.session) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    chrome.storage.session.remove(key, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function scriptingExecuteScript(details) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(details, (results) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(results);
    });
  });
}
