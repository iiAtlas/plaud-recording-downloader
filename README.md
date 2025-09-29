# Atlas Notes Audio Downloader

Browser extension scaffold for downloading audio files from Atlas Notes on [app.plaud.ai](https://app.plaud.ai/). The project uses Manifest V3 with a service worker background script, a content script that scrapes Plaud’s recording list, resolves temporary download URLs via the Plaud API, and a popup UI that triggers downloads through the Chrome downloads API.

## Structure

```
extension/
├── background/service.js      # Handles download requests from the popup
├── content/content.js         # Collects recordings, resolves Plaud temp URLs, and provides metadata
├── lib/auth-probe.js          # Injected helper that reads the Plaud JWT from the page context
├── lib/messaging.js           # Shared message helpers and utilities
├── manifest.json              # Chrome manifest v3 configuration
└── popup/                     # Popup UI (HTML/CSS/JS)
```

## Getting Started

1. Confirm `extension/manifest.json` lists `https://app.plaud.ai/*` under both `host_permissions` and `content_scripts.matches`. Adjust if the domain changes.
2. Open Chrome and go to `chrome://extensions`.
3. Toggle on **Developer mode**.
4. Click **Load unpacked** and select the `extension` directory.
5. Visit [app.plaud.ai](https://app.plaud.ai/), sign in, navigate to the recordings list, and open the popup to trigger a scan. The extension tries to detect recording IDs (`fileId`) and will request Plaud’s `file/temp-url/{fileId}` endpoint to fetch signed download links.
6. (Optional) Use the popup’s **Save files in** field to choose a subfolder (inside Downloads) for exported audio. Leave it blank to keep Chrome’s default download path.
7. (Optional) Choose a post-download action: do nothing (default), move the recording to a Plaud folder (supply its tag ID), or send it to the Plaud trash.

## Building a Zip Bundle

```
npm run build
```

The zipped build will be written to `dist/atlas-notes-downloader.zip`. The build script simply packages the `extension/` directory for manual distribution or publication.

## Notes on Plaud Integration

- The content script injects a small helper into the page to read Plaud’s JWT token from local/session storage so requests to `https://api.plaud.ai/file/temp-url/{fileId}` include the same bearer token that the web app uses. If the token expires, the script retries once after forcing a refresh.
- Recordings without a detectable `fileId` stay disabled in the popup. Open the recording or inspect the DOM to confirm which attributes expose the `fileId`, then update `extractFileIdentifier` in `extension/content/content.js` if Plaud changes its markup.
- Move/trash actions reuse the Plaud auth token to call `https://api.plaud.ai/file/update-tags` or `https://api.plaud.ai/file/trash/`. Provide the destination folder’s tag ID in the popup settings before enabling “Move to folder.”

## Next Steps

- Test on a real Plaud account and fine‑tune the DOM selectors in the content script so every recording exposes a stable `fileId`.
- Add extension icons (16/48/128 px) to the `extension/` directory and reference them from the manifest.
- Consider adding automated tests or linting once the Plaud parsing logic settles.
