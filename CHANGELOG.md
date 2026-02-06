# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2] - 2026-02-06

- Add better (better) support for Plaud API URLs

## [1.3.1] - 2026-02-05

- Add better support for Plaud API URLs

## [1.3.0] - 2026-01-01

- Fix 401 from selecting the incorrect JWT. Thank you @skinnyandbald !

## [1.2.0] - 2025-12-24

- Added support for "web.plaud.com" in addition to "app.plaud.com"

## [1.1.0] - 2025-10-17

- Update to support the new [https://app.plaud.ai/file-list](https://app.plaud.ai/file-list) dashboard
- Added a "Include Plaud Metadata" option. This is awesome! If checked, it will bake in the recording date and other ID3v2 tags into the file. Nice! See [METATAGS.md](METATAGS.md) for more info.

## [1.0.0] - 2025-10-01

### Initial Release

- Background download queue for Plaud recordings triggered from the content script.
- Popup UI for scanning Plaud pages, configuring download behavior, and starting jobs.
- Toolbar badge updates reflecting download progress and completion.
- Optional post-download actions to move recordings into a Plaud folder or send them to trash.
- Settings synced via `chrome.storage` to remember download subfolders and post-download options.
