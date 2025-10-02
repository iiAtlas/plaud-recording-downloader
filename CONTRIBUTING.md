# Contributing

Thanks for your interest in improving Plaud Recording Downloader! Before you start, please review this guide so we can keep changes easy to review and ship.

## Getting Started

1. Fork the repository and create a feature branch (`git checkout -b feature/my-update`).
2. Install dependencies (`npm install`) if you plan to touch build tooling or run scripts.
3. Load the unpacked extension from the `extension/` directory in Chrome (`chrome://extensions` → Developer Mode → Load unpacked).

## Development Workflow

- Keep changes focused. If you spot unrelated issues, open a separate issue or pull request.
- Follow the existing coding style; use ASCII characters in source files unless non-ASCII is already present.
- Add concise explanatory comments only when necessary (e.g., subtle async behavior). Avoid redundant comments.
- Update or create tests/scripts when practical. If you add temporary tooling for validation, remove it before opening your PR.
- Run `npm run build` before submitting to ensure the packaged zip is clean and free of macOS metadata.

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
