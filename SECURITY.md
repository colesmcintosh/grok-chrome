# Security Policy

## Reporting A Vulnerability

Please report security issues privately by opening a GitHub security advisory for this repository.

Do not include API keys, browser cookies, session tokens, or private page content in public issues.

## Scope

Security-sensitive areas include:

- xAI API key storage and usage.
- Page snapshot collection.
- Browser action execution.
- Content script permissions.
- Any path that could execute arbitrary page JavaScript or leak sensitive data.

## Current Security Model

- The extension stores the xAI API key in `chrome.storage.local`.
- Browser actions require user approval before execution.
- Password field typing is blocked.
- The content script does not expose an arbitrary JavaScript execution tool.
