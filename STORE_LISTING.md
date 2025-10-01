# Chrome Web Store Listing Draft

## Short Description

Fetch Plaud recordings in bulk with background downloads and simple cleanup.

## Long Description

Plaud Recording Downloader helps you save time when you need multiple recordings from Plaud. Scan any Plaud dashboard view, queue every recording (or just the ones you select), and let Chrome download the audio in the background while you keep browsing.

Features include:

- Background download jobs that keep running even if you close the popup.
- Live badge and popup progress so you always know how many recordings remain.
- Automatic file naming with safe filenames and optional subfolders inside your Downloads directory.
- Optional post-download actions to move recordings into a Plaud folder or send them to trash once the download succeeds.

The extension never uploads your recordings anywhere. It only talks to Plaud on your behalf using the token already present in your browser session.

## Highlights

- Bulk-scan Plaud lists and queue recordings with one click.
- Sync download preferences across Chrome profiles via `chrome.storage`.
- Keep the popup open to watch real-time progress for each background job.
- Reduce manual cleanup with automatic folder moves or trashing once downloads finish.

## Update Notes

**1.0.0**

- Initial Chrome Web Store release with background download queueing, real-time popup progress indicator, and optional post-download actions.
