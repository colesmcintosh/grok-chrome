(() => {
  if (window.__grokBrowserAgentLoaded) {
    return;
  }

  window.__grokBrowserAgentLoaded = true;

  const registry = new Map();
  const MAX_ELEMENTS = 80;
  const MAX_TEXT_LENGTH = 7000;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type?.startsWith("grok:")) {
      return false;
    }

    Promise.resolve()
      .then(() => handleMessage(message))
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  });

  async function handleMessage(message) {
    if (message.type === "grok:ping") {
      return { ok: true };
    }

    if (message.type === "grok:snapshot") {
      return {
        ok: true,
        snapshot: snapshotPage()
      };
    }

    if (message.type === "grok:perform") {
      return performAction(message.action);
    }

    return { ok: false, error: "Unknown page tool." };
  }

  function snapshotPage() {
    registry.clear();

    const text = cleanText(document.body?.innerText || "");
    const warnings = detectWarnings(text);

    return {
      title: document.title || "Untitled",
      url: location.href,
      status: "available",
      warnings,
      headings: getHeadings(),
      elements: getInteractiveElements(),
      text: truncate(text, MAX_TEXT_LENGTH)
    };
  }

  function getHeadings() {
    return Array.from(document.querySelectorAll("h1, h2, h3"))
      .filter(isVisible)
      .slice(0, 24)
      .map((heading) => ({
        level: heading.tagName.toLowerCase(),
        text: truncate(cleanText(heading.innerText || heading.textContent || ""), 180)
      }))
      .filter((heading) => heading.text);
  }

  function getInteractiveElements() {
    const selector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='menuitem']",
      "[role='tab']",
      "[contenteditable='true']"
    ].join(",");

    const elements = [];
    const candidates = Array.from(document.querySelectorAll(selector));

    for (const element of candidates) {
      if (elements.length >= MAX_ELEMENTS) {
        break;
      }

      if (!isVisible(element) || isDisabled(element)) {
        continue;
      }

      const ref = `el-${elements.length + 1}`;
      registry.set(ref, element);
      elements.push(describeElement(element, ref));
    }

    return elements;
  }

  function describeElement(element, ref) {
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute("type");
    const role = element.getAttribute("role");
    const kind = [tag, type, role ? `role=${role}` : ""].filter(Boolean).join(":");
    const rect = element.getBoundingClientRect();

    const description = {
      ref,
      kind,
      name: readableName(element),
      placeholder: truncate(element.getAttribute("placeholder") || "", 120),
      title: truncate(element.getAttribute("title") || "", 120),
      href: tag === "a" ? truncate(element.href || "", 220) : "",
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };

    if (tag === "select") {
      description.options = Array.from(element.options)
        .slice(0, 30)
        .map((option) => option.value || cleanText(option.textContent || ""))
        .filter(Boolean);
    }

    return Object.fromEntries(
      Object.entries(description).filter(([, value]) => {
        if (Array.isArray(value)) {
          return value.length > 0;
        }
        if (value && typeof value === "object") {
          return true;
        }
        return Boolean(value);
      })
    );
  }

  async function performAction(action) {
    if (!action || typeof action !== "object") {
      return { ok: false, error: "Invalid action." };
    }

    switch (action.tool) {
      case "click":
        return clickElement(action.args?.ref);
      case "type":
        return typeIntoElement(action.args || {});
      case "select":
        return selectOption(action.args || {});
      case "scroll":
        return scrollPage(action.args || {});
      default:
        return { ok: false, error: `Unsupported page action: ${action.tool}` };
    }
  }

  function clickElement(ref) {
    const element = getElement(ref);
    scrollElementIntoView(element);
    element.focus({ preventScroll: true });
    dispatchPointerSequence(element);
    element.click();
    return { ok: true, summary: `Clicked ${ref}.` };
  }

  function typeIntoElement(args) {
    const element = getElement(args.ref);
    const text = String(args.text || "");

    if (isPasswordField(element)) {
      return {
        ok: false,
        error: "Password fields must be handled manually."
      };
    }

    if (!isTextEntryElement(element)) {
      return {
        ok: false,
        error: `${args.ref} is not a text entry field.`
      };
    }

    scrollElementIntoView(element);
    element.focus({ preventScroll: true });

    if (element.isContentEditable) {
      if (args.replace !== false) {
        element.textContent = "";
      }
      document.execCommand("insertText", false, text);
    } else {
      const input = element;
      const nextValue = args.replace === false ? `${input.value || ""}${text}` : text;
      setNativeValue(input, nextValue);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    if (args.submit) {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true
        })
      );
      element.form?.requestSubmit?.();
    }

    return { ok: true, summary: `Typed into ${args.ref}.` };
  }

  function selectOption(args) {
    const element = getElement(args.ref);
    if (element.tagName.toLowerCase() !== "select") {
      return { ok: false, error: `${args.ref} is not a select element.` };
    }

    const value = String(args.value || "");
    const option = Array.from(element.options).find(
      (candidate) => candidate.value === value || cleanText(candidate.textContent || "") === value
    );

    if (!option) {
      return { ok: false, error: `Option "${value}" is not available.` };
    }

    scrollElementIntoView(element);
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, summary: `Selected ${option.value || value} in ${args.ref}.` };
  }

  function scrollPage(args) {
    const amount = Math.max(120, Math.min(1800, Number(args.amount) || Math.round(window.innerHeight * 0.7)));
    const direction = args.direction === "up" ? -1 : 1;
    window.scrollBy({
      top: amount * direction,
      behavior: "smooth"
    });
    return { ok: true, summary: `Scrolled ${direction === 1 ? "down" : "up"}.` };
  }

  function getElement(ref) {
    if (typeof ref !== "string" || !registry.has(ref)) {
      throw new Error(`Unknown element ref: ${ref || "missing"}.`);
    }

    const element = registry.get(ref);
    if (!element.isConnected || !isVisible(element)) {
      throw new Error(`${ref} is no longer visible.`);
    }

    return element;
  }

  function readableName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || "")
          .join(" ")
      : "";

    const labelText = element.labels?.length
      ? Array.from(element.labels)
          .map((label) => label.innerText)
          .join(" ")
      : "";

    const candidates = [
      element.getAttribute("aria-label"),
      labelledByText,
      labelText,
      element.getAttribute("alt"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.value && ["button", "submit", "reset"].includes(element.getAttribute("type")) ? element.value : "",
      element.innerText,
      element.textContent
    ];

    return truncate(cleanText(candidates.find((candidate) => cleanText(candidate || "")) || ""), 180);
  }

  function detectWarnings(text) {
    const warnings = [];
    if (/captcha|verify you are human|checking your browser|cloudflare/i.test(text)) {
      warnings.push("possible human verification challenge");
    }
    if (/sign in|log in|password|two-factor|2fa|verification code/i.test(text)) {
      warnings.push("possible authentication flow");
    }
    return warnings;
  }

  function isVisible(element) {
    if (!element || element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function isDisabled(element) {
    return Boolean(element.disabled || element.getAttribute("aria-disabled") === "true");
  }

  function isPasswordField(element) {
    return element.tagName.toLowerCase() === "input" && element.type === "password";
  }

  function isTextEntryElement(element) {
    const tag = element.tagName.toLowerCase();
    if (element.isContentEditable || tag === "textarea") {
      return true;
    }

    if (tag !== "input") {
      return false;
    }

    const type = (element.type || "text").toLowerCase();
    return [
      "email",
      "number",
      "search",
      "tel",
      "text",
      "url"
    ].includes(type);
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
      return;
    }
    element.value = value;
  }

  function scrollElementIntoView(element) {
    element.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "smooth"
    });
  }

  function dispatchPointerSequence(element) {
    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const EventClass = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
      element.dispatchEvent(new EventClass(type, base));
    }
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function truncate(value, maxLength) {
    const text = String(value || "").trim();
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
  }
})();
