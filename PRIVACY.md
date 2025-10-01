# Plaud Recording Downloader Privacy Policy

**Effective date:** 2025-10-01

## Summary

Plaud Recording Downloader runs entirely in your browser. It never sends your Plaud recordings or any other personal data to the extension developer, third parties, or external services beyond Plaud itself. The extension's only purpose is to help you scan Plaud pages and download audio files you already have access to.

## Information We Access

- Plaud pages you view: The extension reads recording metadata and download links on `https://app.plaud.ai` in order to list and download audio.
- Authentication tokens: When Plaud exposes a short-lived token on the page, the extension uses it to call Plaud's public API on your behalf. The token stays in memory only long enough to complete the download or optional post-download actions.
- Download settings: Optional preferences (download subfolder, post-download actions, destination tag ID) are stored in `chrome.storage.sync`, so Chrome can sync them between your signed-in browsers.

## How We Use This Information

- Identify recordings shown on the current Plaud dashboard page.
- Request a temporary download URL from Plaud's API so Chrome's download manager can retrieve the audio file.
- Perform any post-download action you choose (move to folder, move to trash) through Plaud's API.
- Remember your preferred download folder or post-download option for future sessions.

## What We Do Not Do

- No data is transmitted to the developer or any third-party servers.
- No analytics, advertising, or profiling is performed.
- No user information is sold or shared.

## Data Retention

- Download preferences remain in Chrome Sync until you clear them (`chrome://settings/syncSetup`).
- Temporary tokens and recording metadata live only in extension memory and are discarded as soon as the download job completes.
- The extension does not store downloaded audio files; Chrome saves them to your disk according to your browser settings.

## User Controls

- Change or clear saved settings through the popup UI or Chrome Sync settings.
- Remove the extension at any time from `chrome://extensions`.
- Manually delete downloaded files using your operating system's file manager.

## Permissions Explained

- `downloads`: Required to instruct Chrome to save audio files.
- `storage`: Used for optional setting sync.
- `tabs`: Used to verify that the active tab is on the Plaud dashboard before sending commands.
- Host access to `https://app.plaud.ai/*`: Lets the content script run on Plaud pages and make authenticated API requests.

## Contact

For privacy questions or concerns, open an issue at https://github.com/atlas/plaud-recording-downloader/issues.
