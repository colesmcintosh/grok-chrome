export const DEFAULT_MODEL = "grok-4.3";
export const DEFAULT_MAX_STEPS = 6;
export const MAX_ACTIONS_PER_TURN = 4;
export const MAX_HISTORY_MESSAGES = 16;

export const TOOL_DESCRIPTIONS = [
  {
    tool: "navigate",
    args: "{ url: string }",
    policy: "Open an http or https URL in the active tab."
  },
  {
    tool: "click",
    args: "{ ref: string }",
    policy: "Click a visible interactive element from the latest page snapshot."
  },
  {
    tool: "type",
    args: "{ ref: string, text: string, submit?: boolean, replace?: boolean }",
    policy: "Type into a text input, textarea, or contenteditable element. Password fields are blocked."
  },
  {
    tool: "select",
    args: "{ ref: string, value: string }",
    policy: "Select an option in a referenced select element."
  },
  {
    tool: "scroll",
    args: "{ direction: 'up' | 'down', amount?: number }",
    policy: "Scroll the page."
  },
  {
    tool: "wait",
    args: "{ ms?: number }",
    policy: "Wait briefly before reading the page again."
  },
  {
    tool: "ask_user",
    args: "{ question: string }",
    policy: "Ask the user to handle login, CAPTCHA, MFA, credentials, payments, or ambiguous choices."
  }
];

const ALLOWED_TOOLS = new Set(TOOL_DESCRIPTIONS.map((tool) => tool.tool));

export function buildSystemPrompt() {
  const tools = TOOL_DESCRIPTIONS.map(
    (tool) => `- ${tool.tool}: ${tool.args}. ${tool.policy}`
  ).join("\n");

  return [
    "You are Grok operating as a browser agent inside Chrome.",
    "You receive a compact snapshot of the active tab and a list of referenced visible elements.",
    "Use browser tools only when they are needed to satisfy the user's request.",
    "Return exactly one JSON object. Do not wrap it in Markdown.",
    'The JSON shape is: {"message":"short user-facing update","actions":[{"tool":"tool_name","args":{}}]}',
    "If no browser action is needed, return an empty actions array and put the answer in message.",
    "Use element refs exactly as shown in the current snapshot. Do not invent refs.",
    "Never ask to type passwords, payment card data, one-time codes, secrets, or private keys.",
    "If login, CAPTCHA, MFA, a permission prompt, or a sensitive confirmation is required, use ask_user.",
    "Prefer one small batch of actions at a time. The user approves actions before they run.",
    "",
    "Available tools:",
    tools
  ].join("\n");
}

export function buildBrowserContext(snapshot, observations = []) {
  const tabLines = [
    "Active tab snapshot:",
    `Title: ${snapshot?.title || "Untitled"}`,
    `URL: ${snapshot?.url || "unknown"}`,
    `Status: ${snapshot?.status || "available"}`
  ];

  if (snapshot?.warnings?.length) {
    tabLines.push(`Page warnings: ${snapshot.warnings.join("; ")}`);
  }

  const headings = formatLines(
    "Headings",
    snapshot?.headings?.map((heading) => `- ${heading.level}: ${heading.text}`)
  );
  const elements = formatLines(
    "Interactive elements",
    snapshot?.elements?.map((element) => {
      const parts = [
        `${element.ref}: ${element.kind}`,
        element.name ? `"${element.name}"` : "",
        element.href ? `href=${element.href}` : "",
        element.placeholder ? `placeholder="${element.placeholder}"` : "",
        element.options?.length ? `options=[${element.options.join(", ")}]` : ""
      ].filter(Boolean);
      return `- ${parts.join(" ")}`;
    })
  );
  const observationLines = formatLines(
    "Tool observations",
    observations.map((observation) => {
      const status = observation.ok ? "ok" : "error";
      return `- ${observation.tool}: ${status} - ${observation.summary}`;
    })
  );

  return [
    ...tabLines,
    headings,
    elements,
    observationLines,
    "Visible text excerpt:",
    snapshot?.text || "(no visible text captured)"
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGrokMessages(history, snapshot, observations = []) {
  const conversation = normalizeHistory(history);
  const { priorMessages, userRequest } = splitLatestUserRequest(conversation);

  return [
    { role: "system", content: buildSystemPrompt() },
    ...priorMessages,
    {
      role: "user",
      content: buildAgentTurnPrompt(userRequest, snapshot, observations)
    }
  ];
}

export function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: clampString(message.content, 8000)
    }))
    .filter((message) => message.content.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);
}

export function buildAgentTurnPrompt(userRequest, snapshot, observations = []) {
  const request = userRequest || "Continue the current browser task.";
  return [
    "User request:",
    request,
    "",
    buildBrowserContext(snapshot, observations),
    "",
    "Action decision rules:",
    "- If the user asks to open, go to, navigate, click, search, type, fill, select, scroll, submit, or otherwise change browser state, return browser actions.",
    "- If a search requires a text field and submit control, you may type with submit=true when the referenced field supports it.",
    "- If the request can be answered from the current browser state without changing the page, return an empty actions array.",
    "- If the page is restricted, stale, blocked by login, or needs human verification, use ask_user.",
    "- Return exactly one JSON object with message and actions."
  ].join("\n");
}

function splitLatestUserRequest(conversation) {
  const latestUserIndex = conversation.findLastIndex((message) => message.role === "user");
  if (latestUserIndex === -1) {
    return {
      priorMessages: conversation,
      userRequest: ""
    };
  }

  return {
    priorMessages: conversation.slice(0, latestUserIndex),
    userRequest: conversation[latestUserIndex].content
  };
}

export function parseAssistantPayload(text) {
  const fallback = {
    message: typeof text === "string" ? text.trim() : "",
    actions: [],
    parsed: null
  };

  if (typeof text !== "string" || !text.trim()) {
    return fallback;
  }

  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }

    return {
      message: clampString(
        firstString(parsed.message, parsed.response, parsed.final, ""),
        12000
      ),
      actions: normalizeActions(parsed.actions),
      parsed
    };
  } catch {
    return fallback;
  }
}

export function normalizeActions(actions) {
  if (!Array.isArray(actions)) {
    return [];
  }

  return actions
    .map(normalizeAction)
    .filter(Boolean)
    .slice(0, MAX_ACTIONS_PER_TURN);
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  const tool = firstString(action.tool, action.name, "").trim().toLowerCase();
  if (!ALLOWED_TOOLS.has(tool)) {
    return null;
  }

  const args = normalizeArgsForTool(tool, action.args);
  if (!args) {
    return null;
  }

  return { tool, args };
}

function normalizeArgsForTool(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }

  if (tool === "navigate") {
    return normalizeNavigateArgs(args);
  }
  if (tool === "click") {
    return normalizeClickArgs(args);
  }
  if (tool === "type") {
    return normalizeTypeArgs(args);
  }
  if (tool === "select") {
    return normalizeSelectArgs(args);
  }
  if (tool === "scroll") {
    return normalizeScrollArgs(args);
  }
  if (tool === "wait") {
    return normalizeWaitArgs(args);
  }
  if (tool === "ask_user") {
    return normalizeAskUserArgs(args);
  }
  return null;
}

function normalizeNavigateArgs(args) {
  const url = normalizeRequiredString(args.url, 2000);
  return url ? { url } : null;
}

function normalizeClickArgs(args) {
  const ref = normalizeRef(args.ref);
  return ref ? { ref } : null;
}

function normalizeTypeArgs(args) {
  const ref = normalizeRef(args.ref);
  if (!ref || typeof args.text !== "string") {
    return null;
  }

  const normalized = {
    ref,
    text: clampString(args.text, 4000)
  };

  if (typeof args.submit === "boolean") {
    normalized.submit = args.submit;
  }
  if (typeof args.replace === "boolean") {
    normalized.replace = args.replace;
  }

  return normalized;
}

function normalizeSelectArgs(args) {
  const ref = normalizeRef(args.ref);
  const value = normalizeRequiredString(args.value, 1000);
  return ref && value ? { ref, value } : null;
}

function normalizeScrollArgs(args) {
  if (!["up", "down"].includes(args.direction)) {
    return null;
  }

  const normalized = {
    direction: args.direction
  };

  const amount = normalizeFiniteNumber(args.amount);
  if (amount != null) {
    normalized.amount = Math.max(120, Math.min(1800, amount));
  }

  return normalized;
}

function normalizeWaitArgs(args) {
  const ms = normalizeFiniteNumber(args.ms);
  return {
    ms: Math.max(250, Math.min(5000, ms || 1000))
  };
}

function normalizeAskUserArgs(args) {
  const question = normalizeRequiredString(args.question, 1000);
  return question ? { question } : null;
}

export function summarizeAction(action) {
  if (!action || typeof action !== "object") {
    return "Unknown action";
  }

  const args = action.args || {};
  if (action.tool === "navigate") {
    return `Navigate to ${args.url || "a URL"}`;
  }
  if (action.tool === "click") {
    return `Click ${args.ref || "an element"}`;
  }
  if (action.tool === "type") {
    const length = typeof args.text === "string" ? args.text.length : 0;
    return `Type ${length} character${length === 1 ? "" : "s"} into ${args.ref || "a field"}`;
  }
  if (action.tool === "select") {
    return `Select ${args.value || "an option"} in ${args.ref || "a field"}`;
  }
  if (action.tool === "scroll") {
    return `Scroll ${args.direction === "up" ? "up" : "down"}`;
  }
  if (action.tool === "wait") {
    return `Wait ${Math.min(Number(args.ms) || 1000, 5000)} ms`;
  }
  if (action.tool === "ask_user") {
    return args.question || "Ask the user";
  }
  return action.tool;
}

function formatLines(title, lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return `${title}:\n- none`;
  }
  return `${title}:\n${lines.join("\n")}`;
}

function extractJsonCandidate(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return "";
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function firstString(...values) {
  const value = values.find((candidate) => typeof candidate === "string");
  return value || "";
}

function normalizeRef(value) {
  const ref = normalizeRequiredString(value, 80);
  return /^el-\d+$/.test(ref) ? ref : "";
}

function normalizeRequiredString(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  return clampString(value, maxLength);
}

function normalizeFiniteNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function clampString(value, maxLength) {
  const normalized = String(value || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}
