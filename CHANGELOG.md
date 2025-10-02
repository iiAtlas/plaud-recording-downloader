# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Download-all button now toggles to "Stop" while a job is running, letting you cancel background downloads mid-queue.
- Added ESLint + Prettier tooling with npm scripts for linting (`npm run lint`) and formatting (`npm run format`).

### Changed

- Popup progress messages reflect cancelling and cancelled job stages alongside badge updates.

### Fixed

- Reduced false "Open the Plaud dashboard" prompts by retrying messaging while the content script loads.

## [1.0.0] - 2025-10-01

### Added

- Background download queue for Plaud recordings triggered from the content script.
- Popup UI for scanning Plaud pages, configuring download behavior, and starting jobs.
- Toolbar badge updates reflecting download progress and completion.
- Optional post-download actions to move recordings into a Plaud folder or send them to trash.
- Settings synced via `chrome.storage` to remember download subfolders and post-download options.
- Store listing copy and privacy policy documentation for Chrome Web Store submission.

### Changed

- Build script prevents macOS metadata (`.DS_Store`) from being packaged into release zips.

### Fixed

- Sanitized filenames and subdirectory paths to avoid invalid characters while saving audio.
