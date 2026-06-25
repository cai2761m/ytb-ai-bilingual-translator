[English](./README.md) | [中文](./README_zh.md)

# ytb-ai-bilingual-translator

## About

A Chrome extension (Manifest V3) that brings **AI-powered bilingual subtitles** to YouTube. It automatically fetches the English caption track from any YouTube video, merges fragmented cues into natural sentence-level segments, translates them into Chinese (Simplified or Traditional) via a configurable LLM API, and renders a sleek **Chinese-English subtitle overlay** directly on the video player — all while hiding YouTube's native CC window.

No audio recognition is needed; the extension works entirely from YouTube's existing caption data.

## Features

- **Sentence-aware caption merging** — reassembles YouTube's word/phrase-level caption fragments into complete, readable sentences and avoids obvious broken boundaries such as "following your / nose".
- **AI-powered translation** — translates subtitles using LLM APIs with context-aware prompts for natural, high-quality results.
- **Priority-based scheduling** — translates captions near the current playback position first, then continues with the rest of the video in the background.
- **ASR error correction** — optionally uses AI to fix common auto-generated subtitle mistakes before translation.
- **Draggable overlay** — the bilingual subtitle overlay can be repositioned via long-press drag, and the position is persisted.
- **Adjustable font size** — subtitle size can be scaled from 0.7× to 1.8× via the options page.
- **Stable translation cache** — caches translated cues in `chrome.storage.local` with stable video/track fingerprints, so refreshing the same video reuses existing translations instead of calling the API again.
- **In-flight request deduplication** — if a page is refreshed while translations are still running, duplicate requests for the same cue reuse the existing background request when possible.
- **Parallel batch translation** — sends multiple batches concurrently with provider-specific batch sizes, smart back-off, partial-result handling, and retry logic for rate limits, malformed JSON, missing cue results, and server errors.
- **Multiple translation providers**:
  - **DeepSeek** (default) — works out of the box with an API key.
  - **Gemini** — Google's Gemini API with dedicated batching parameters.
  - **Custom OpenAI-compatible API** — any provider that implements the OpenAI Chat Completions interface, including API relay / model pool services.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **"Load unpacked"**.
4. Select the project folder you downloaded or cloned.
5. Click the extension icon to open settings and configure a translation API.

## Usage

1. Navigate to any YouTube video with English captions.
2. The extension automatically detects caption tracks (prefers auto-generated `asr`, falls back to manual tracks).
3. Bilingual subtitles appear on the video in real time as captions are translated.
4. If no English caption track is found, a "not found" status is displayed.

## Configuration

Open the extension's options page (click the extension icon → settings) to configure:

| Setting | Description |
|---|---|
| **Translation Provider** | DeepSeek / Gemini / Custom OpenAI-compatible |
| **API Key** | Your API key for the selected provider |
| **Base URL** | API endpoint (auto-filled for DeepSeek & Gemini) |
| **Model** | Model name (auto-filled for DeepSeek & Gemini) |
| **JSON Response Mode** | Request structured JSON output (disable if your provider doesn't support it) |
| **ASR Correction** | Toggle AI-based speech recognition error correction |
| **Source Language** | English |
| **Target Language** | Simplified Chinese / Traditional Chinese |
| **Font Scale** | Subtitle size multiplier (0.7× – 1.8×) |
| **Subtitle Enabled** | Toggle the overlay on/off and hide native YouTube CC |

### Custom OpenAI-Compatible APIs

For an OpenAI-compatible relay service, select **Custom OpenAI-compatible API** and fill in:

| Field | Example |
|---|---|
| **API Key** | `sk-...` |
| **Base URL** | `https://anpin.ai/v1` |
| **Model** | `gpt-5.4` |

Keep **JSON Response Mode** enabled first. If a provider does not support OpenAI JSON mode, disable it and the extension will still try to parse and recover usable translation results.

### Cache Behavior

The extension caches translations by video, source track identity, provider, endpoint, model, source language, target language, ASR correction mode, merge version, and cache version. Refreshing the same YouTube video should reuse cached translated cues. A new API request is expected only when:

- the cue has never been translated successfully;
- the model, provider, Base URL, target language, source language, or ASR correction setting changes;
- the local translation cache is cleared;
- the subtitle merge algorithm version changes.

## Project Structure

```
├── manifest.json          # Chrome MV3 extension manifest
├── src/
│   ├── background.js      # Service worker: handles API calls & message routing
│   ├── content.js         # Content script: caption fetching, translation queue, overlay rendering
│   ├── shared.js          # Shared utilities: settings, caption merging, prompt generation
│   ├── overlay.css        # Subtitle overlay styles
│   └── page-bridge.js     # Page-level script injected to intercept YouTube player data
├── options/
│   ├── options.html       # Settings UI
│   ├── options.css        # Settings page styles
│   └── options.js         # Settings page logic
└── test/                  # Unit tests
```

## Development

Run the unit tests with:

```powershell
node --test
```

If PowerShell blocks `npm.ps1`, use `node --test` directly or run `npm.cmd test`.

## License

MIT
