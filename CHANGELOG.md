# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Draft Chrome Web Store listing copy and repository privacy policy.

### Changed
- Build script prevents macOS metadata (`.DS_Store`) from being packaged into release zips.

## [0.1.0] - 2025-10-01

### Added
- Background download queue for Plaud recordings triggered from the content script.
- Popup UI for scanning Plaud pages, configuring download behavior, and starting jobs.
- Toolbar badge updates reflecting download progress and completion.
- Optional post-download actions to move recordings into a Plaud folder or send them to trash.
- Settings synced via `chrome.storage` to remember download subfolders and post-download options.

### Fixed
- Sanitized filenames and subdirectory paths to avoid invalid characters while saving audio.
