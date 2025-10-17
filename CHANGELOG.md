# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-10-17

- Update to support the new [https://app.plaud.ai/file-list](https://app.plaud.ai/file-list) dashboard

## [1.0.0] - 2025-10-01

### Initial Release

- Background download queue for Plaud recordings triggered from the content script.
- Popup UI for scanning Plaud pages, configuring download behavior, and starting jobs.
- Toolbar badge updates reflecting download progress and completion.
- Optional post-download actions to move recordings into a Plaud folder or send them to trash.
- Settings synced via `chrome.storage` to remember download subfolders and post-download options.
