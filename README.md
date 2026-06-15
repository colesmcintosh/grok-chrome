# Grok Chrome

[![CI](https://github.com/colesmcintosh/grok-chrome/actions/workflows/ci.yml/badge.svg)](https://github.com/colesmcintosh/grok-chrome/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-black)](https://bun.sh/)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-111111)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)

Grok Chrome is a Chrome Manifest V3 extension that puts an xAI Grok chat agent in the browser side panel. It can inspect the active tab, propose browser actions through the Vercel AI SDK, and run those actions only after the user approves them.

## Features

- Side-panel chat interface for the active tab.
- Local xAI API key prompt using `chrome.storage.local`.
- Default `grok-4.3` model.
- User-approved browser actions for navigation, clicks, typing, selecting, scrolling, and waits.
- Page snapshots with visible text, headings, and referenced interactive elements.
- No arbitrary JavaScript execution tool exposed to the model.
- Password field typing is blocked.

## Install Locally

Requirements:

- Chrome 116 or newer.
- [Bun](https://bun.sh/) 1.3.5 or newer.
- An xAI API key from <https://console.x.ai/>.

Build and load the extension:

```sh
bun install
bun run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository directory.
5. Click the **Grok Chrome** extension action to open the side panel.
6. Paste your xAI API key when prompted.

After source changes, run `bun run build` again and reload the extension from `chrome://extensions`.

## Usage

Open a normal web page and ask Grok to inspect or act on it.

Examples:

```text
Summarize this page.
```

```text
Click Pricing.
```

```text
Search for browser automation docs.
```

When Grok wants to change the page, the side panel shows an approval card. Click **Run** to execute the proposed browser action.

## Browser Tools

Grok can request these actions:

- `navigate`: open an HTTP or HTTPS URL in the active tab.
- `click`: click a referenced visible page element.
- `type`: type into a referenced text field or editable element.
- `select`: choose an option in a referenced `<select>`.
- `scroll`: scroll the active page.
- `wait`: pause before inspecting the page again.
- `ask_user`: stop and ask the user for manual input.

## Development

Run the full local check:

```sh
bun run check
```

This command:

1. Bundles the MV3 service worker to `dist/background/service-worker.js`.
2. Runs the Bun test suite.
3. Syntax-checks the bundled service worker and source entry points.

Useful commands:

```sh
bun run build
bun test
```

## Project Structure

```text
src/background/     MV3 service worker and Grok action loop
src/content/        Content script for snapshots and approved page actions
src/shared/         Agent prompt and action protocol helpers
src/sidepanel/      Side-panel UI
tests/              Protocol regression tests
scripts/            Build scripts
```

## Security

The extension sends page snapshots and chat prompts to xAI when you use the side panel. Do not use it on pages containing information you do not want processed by the configured model provider.

API keys are stored locally in Chrome extension storage. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

MIT. See [LICENSE](LICENSE).
