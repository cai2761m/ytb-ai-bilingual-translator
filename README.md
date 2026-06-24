# YouTube Bilingual API Subtitles

Chrome MV3 extension that reads YouTube's available English caption track, merges fragmented captions into readable sentence-like cues, pre-translates them with a configurable translation API, and renders a custom Chinese-English subtitle overlay while hiding YouTube's native CC window.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this folder: `C:\Users\34254\Documents\字幕8888`.
5. Click the extension icon to open settings and configure a translation API.

## Behavior

- The extension first looks for an English auto-caption track (`kind=asr`) and falls back to other English caption tracks.
- It fetches the full timedtext caption track, tries `fmt=json3`, and falls back to VTT parsing.
- It prioritizes translating captions near the current playback position, then continues translating the rest of the video in the background.
- If no English caption track exists, it shows a "not found" status instead of doing audio recognition.
- DeepSeek is the default translation provider. Other OpenAI-compatible Chat Completions APIs can be used by selecting "Custom OpenAI-compatible API" and entering the API key, base URL, and model name.

## Development

Run the unit tests with:

```powershell
node --test
```

If PowerShell blocks `npm.ps1`, use `node --test` directly or run `npm.cmd test`.
