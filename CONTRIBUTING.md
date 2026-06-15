# Contributing

Thanks for considering a contribution to Grok Chrome.

## Development Setup

```sh
bun install
bun run check
```

Load the repository as an unpacked extension from `chrome://extensions` after running `bun run build`.

## Pull Requests

- Keep changes focused and easy to review.
- Add or update tests for behavior changes.
- Run `bun run check` before opening a pull request.
- Do not commit secrets, local browser profiles, generated `dist/` files, `node_modules/`, or local tool configuration.

## Code Style

The project uses plain JavaScript, Chrome MV3 APIs, and small modules. Prefer explicit browser-extension APIs and focused helpers over new dependencies.
