# FFmpeg Compressor Chrome Extension

This folder is a load-unpacked Chrome extension. It runs FFmpeg through bundled WebAssembly in the extension page, so compression and conversion run locally in Chrome instead of through the old Flask server.

## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this `extension` folder.
5. Click the extension icon to open the compressor page.

## Notes

- Output is saved through Chrome's download/save dialog. Extensions cannot write directly to an arbitrary filesystem path without a native helper.
- This uses browser WebAssembly, so it uses the device CPU and memory available to Chrome. It does not use native FFmpeg hardware encoders such as NVENC, Quick Sync, or AMF.
- Large files can hit browser memory limits more easily than the original Python/native FFmpeg version.
