<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/242b4ff0-61d8-45cb-99cd-e1a841b66b55

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Desktop builds

The desktop app keeps the existing Express API and React workbench, starts the API on
the local computer, and opens it in an Electron window. A Gemini API key is required;
when configured in the app, it is encrypted using the operating system's secure storage.

- Windows installer (`.exe`): run `npm run desktop:win` on Windows.
- macOS disk image (`.dmg`): run `npm run desktop:mac` on macOS.

Builds are written to `release/`. The macOS package must be built on a Mac; code signing
and notarization are separate release steps.

Work history and original audio are stored locally and kept until manually removed:

- Windows: `%LOCALAPPDATA%\ASR语音转写质检与校准工作台\作业历史`
- macOS: `~/Library/Application Support/ASR语音转写质检与校准工作台/作业历史`

The batch summary page displays the active storage path. Removing an item from the
workbench only removes it from the current queue; delete its folder under `作业历史`
to permanently remove the saved record and audio.
