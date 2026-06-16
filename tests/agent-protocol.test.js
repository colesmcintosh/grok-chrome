import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGrokMessages,
  buildBrowserContext,
  normalizeActions,
  normalizeHistory,
  parseAssistantPayload,
  summarizeAction
} from "../src/shared/agent-protocol.js";

test("parseAssistantPayload reads the required JSON shape", () => {
  const result = parseAssistantPayload(
    '{"message":"I will click the search box.","actions":[{"tool":"click","args":{"ref":"el-2"}}]}'
  );

  assert.equal(result.message, "I will click the search box.");
  assert.deepEqual(result.actions, [{ tool: "click", args: { ref: "el-2" } }]);
});

test("parseAssistantPayload tolerates fenced JSON and rejects unknown tools", () => {
  const result = parseAssistantPayload(`Here is the plan:
\`\`\`json
{
  "message": "Working.",
  "actions": [
    { "tool": "eval", "args": { "code": "alert(1)" } },
    { "tool": "scroll", "args": { "direction": "down" } }
  ]
}
\`\`\``);

  assert.equal(result.message, "Working.");
  assert.deepEqual(result.actions, [{ tool: "scroll", args: { direction: "down" } }]);
});

test("plain text is treated as a final assistant message", () => {
  const result = parseAssistantPayload("The page is already complete.");

  assert.equal(result.message, "The page is already complete.");
  assert.deepEqual(result.actions, []);
});

test("normalizeHistory keeps only chat roles and trims old messages", () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`
  }));
  history.push({ role: "system", content: "ignored" });

  const result = normalizeHistory(history);

  assert.equal(result.length, 16);
  assert.equal(result[0].content, "message 4");
  assert.equal(result.at(-1).content, "message 19");
});

test("normalizeActions caps action count and string size", () => {
  const actions = Array.from({ length: 8 }, (_, index) => ({
    tool: "type",
    args: {
      ref: `el-${index}`,
      text: "x".repeat(5000)
    }
  }));

  const result = normalizeActions(actions);

  assert.equal(result.length, 4);
  assert.equal(result[0].args.text.length, 4000);
});

test("normalizeActions validates required args per tool", () => {
  const result = normalizeActions([
    { tool: "click", args: { ref: "missing-prefix" } },
    { tool: "navigate", args: { url: "" } },
    { tool: "select", args: { ref: "el-1" } },
    { tool: "ask_user", args: { question: "Choose an account?" } }
  ]);

  assert.deepEqual(result, [
    { tool: "ask_user", args: { question: "Choose an account?" } }
  ]);
});

test("normalizeActions keeps only supported args for each tool", () => {
  const result = normalizeActions([
    {
      tool: "type",
      args: {
        ref: "el-2",
        text: "hello",
        submit: true,
        replace: false,
        ignored: "value"
      }
    },
    {
      tool: "scroll",
      args: {
        direction: "down",
        amount: 9999,
        ignored: "value"
      }
    },
    {
      tool: "wait",
      args: {
        ms: 25,
        ignored: "value"
      }
    }
  ]);

  assert.deepEqual(result, [
    {
      tool: "type",
      args: {
        ref: "el-2",
        text: "hello",
        submit: true,
        replace: false
      }
    },
    {
      tool: "scroll",
      args: {
        direction: "down",
        amount: 1800
      }
    },
    {
      tool: "wait",
      args: {
        ms: 250
      }
    }
  ]);
});

test("buildBrowserContext includes warnings, refs, text, and observations", () => {
  const context = buildBrowserContext(
    {
      title: "Example",
      url: "https://example.com",
      status: "available",
      warnings: ["possible authentication flow"],
      headings: [{ level: "h1", text: "Welcome" }],
      elements: [{ ref: "el-1", kind: "button", name: "Continue" }],
      text: "Visible page text"
    },
    [{ ok: true, tool: "click", summary: "Clicked el-1." }]
  );

  assert.match(context, /possible authentication flow/);
  assert.match(context, /el-1: button "Continue"/);
  assert.match(context, /Visible page text/);
  assert.match(context, /click: ok - Clicked el-1/);
});

test("buildGrokMessages puts the latest user request in the final browser turn", () => {
  const messages = buildGrokMessages(
    [
      { role: "user", content: "Summarize the page." },
      { role: "assistant", content: "Done." },
      { role: "user", content: "Click the pricing link." }
    ],
    {
      title: "xAI",
      url: "https://x.ai",
      status: "available",
      headings: [],
      elements: [{ ref: "el-2", kind: "a", name: "Pricing", href: "https://x.ai/pricing" }],
      text: "Frontier AI models"
    }
  );

  assert.equal(messages.at(-1).role, "user");
  assert.match(messages.at(-1).content, /User request:\nClick the pricing link\./);
  assert.match(messages.at(-1).content, /el-2: a "Pricing"/);
  assert.doesNotMatch(messages.at(-1).content, /User request:\nSummarize the page\./);
});

test("summarizeAction avoids leaking typed text", () => {
  const summary = summarizeAction({
    tool: "type",
    args: {
      ref: "el-4",
      text: "private value"
    }
  });

  assert.equal(summary, "Type 13 characters into el-4");
});
