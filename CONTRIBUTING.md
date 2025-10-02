# Contributing

Thanks for your interest in improving Plaud Recording Downloader! Before you start, please review this guide so we can keep changes easy to review and ship.

## Project Structure

```
extension/
├── background/service.js      # Handles download requests from the popup
├── content/content.js         # Collects recordings, resolves Plaud temp URLs, and provides metadata
├── lib/auth-probe.js          # Injected helper that reads the Plaud JWT from the page context
├── lib/messaging.js           # Shared message helpers and utilities
├── manifest.json              # Chrome manifest v3 configuration
├── icons/                     # Browser action + store listing icons (16–512 px)
├── _locales/en/messages.json  # Localized name/description for Chrome Web Store
└── popup/                     # Popup UI (HTML/CSS/JS)
```

## Local Setup

1. Fork the repository and create a feature branch (`git checkout -b feature/my-update`).
2. Install dependencies (`npm install`) if you plan to touch build tooling or run scripts.
3. Load the unpacked extension from the `extension/` directory in Chrome (`chrome://extensions` → Developer Mode → Load unpacked).
4. Visit [app.plaud.ai](https://app.plaud.ai/), sign in, and keep the tab open so the content script can run.

### Plaud integration tips

- The content script injects a helper that reads Plaud’s JWT token from the page context. Requests to Plaud APIs reuse that token and retry once if it expires.
- Recordings without a detectable `fileId` stay disabled in the popup. Inspect Plaud’s DOM and update the selectors in `extension/content/content.js` if their markup changes.
- Move/trash actions reuse Plaud’s APIs (`file/update-tags`, `file/trash`). Supply the destination tag ID in the popup settings before enabling the move option.

## Development Workflow

- Keep changes focused. If you spot unrelated issues, open a separate issue or pull request.
- Follow the existing coding style; use ASCII characters in source files unless non-ASCII is already present.
- Add concise explanatory comments only when necessary (e.g., subtle async behavior). Avoid redundant comments.
- Update or create tests/scripts when practical. If you add temporary tooling for validation, remove it before opening your PR.
- Run `npm run lint` and `npm run format:check` before submitting to keep style consistent.
- Run `npm run build` before submitting to ensure the packaged zip is clean and free of macOS metadata.

### Building a release zip

```
npm run build
```

The zipped build is written to `dist/plaud-recording-downloader.zip` and bundles the `extension/` directory for manual distribution or Chrome Web Store submission.

### Preparing Chrome Web Store submissions

- Use `STORE_LISTING.md` for draft copy and release notes.
- Host `PRIVACY.md` publicly and reference it in the developer dashboard.
- Bump `version` and `version_name` in `extension/manifest.json` and update `CHANGELOG.md` before packaging.
- Capture popup screenshots at 1280×800 (or 640×400) for the listing gallery.

## Commit & PR Guidelines

- Reference related issues (e.g., “Fixes #123”) in your pull request description.
- Update documentation (`README.md`, `PRIVACY.md`, `STORE_LISTING.md`, etc.) when behavior or external-facing details change.
- Update `CHANGELOG.md` under the “Unreleased” section to describe user-impacting changes.
- Include screenshots or screencasts when modifying the UI or user flows.
- Ensure CI (if configured) passes before requesting review.

## Reporting Bugs

Open a GitHub issue with:

- Steps to reproduce
- Expected vs. actual outcome
- Screenshots, console logs, or network traces if helpful

Thanks again for contributing! Feel free to tag @atlas for questions or to request review.
