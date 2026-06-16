import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeMaxSteps,
  normalizeNavigationUrl
} from "../src/shared/browser-policy.js";

test("normalizeNavigationUrl accepts http and https destinations", () => {
  assert.equal(normalizeNavigationUrl("example.com"), "https://example.com/");
  assert.equal(normalizeNavigationUrl("http://example.com/path"), "http://example.com/path");
  assert.equal(normalizeNavigationUrl("https://example.com/search?q=docs"), "https://example.com/search?q=docs");
});

test("normalizeNavigationUrl rejects unsafe or missing destinations", () => {
  assert.throws(() => normalizeNavigationUrl(""), /Navigation needs a URL/);
  assert.throws(() => normalizeNavigationUrl("javascript:alert(1)"), /Only HTTP and HTTPS/);
  assert.throws(() => normalizeNavigationUrl("file:///tmp/example.txt"), /Only HTTP and HTTPS/);
});

test("normalizeMaxSteps clamps configured step counts", () => {
  assert.equal(normalizeMaxSteps("4", 6), 4);
  assert.equal(normalizeMaxSteps("0", 6), 6);
  assert.equal(normalizeMaxSteps("40", 6), 12);
  assert.equal(normalizeMaxSteps("-1", 6), 6);
  assert.equal(normalizeMaxSteps("not a number", 6), 6);
  assert.equal(normalizeMaxSteps("2.9", 6), 2);
});
