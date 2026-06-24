(function attachShared(root) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    deepseekApiKey: "",
    translationProvider: "deepseek",
    translationApiKey: "",
    translationBaseUrl: "",
    translationModel: "",
    translationJsonResponse: true,
    targetLanguage: "zh-CN",
    sourceLanguage: "en",
    fontScale: 1,
    subtitleEnabled: true,
    subtitlePosition: null,
    cacheVersion: "1",
    translationCacheMaxItems: 2000
  });

  const DEEPSEEK_MODEL = "deepseek-v4-flash";
  const MERGE_VERSION = "1";
  const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

  // Upper bound on the number of cached cue translations. Each `ytbt:` storage
  // key holds an entire video; once this many cached cues accumulate, the
  // least-recently-updated video keys are evicted to stay under the quota.
  const DEFAULT_CACHE_MAX_ITEMS = 2000;

  // Human-readable labels for the languages the prompt references. Unknown
  // codes fall back to a safe default so the prompt always reads sensibly.
  const LANGUAGE_LABELS = {
    "en": "English",
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese"
  };

  function languageLabel(code, fallback) {
    const key = String(code || "").trim();
    if (LANGUAGE_LABELS[key]) {
      return LANGUAGE_LABELS[key];
    }
    // Handle regional variants like "en-US" by matching the base code.
    const base = key.split("-")[0];
    return LANGUAGE_LABELS[base] || fallback || "English";
  }

  function sourceLanguageLabel(code) {
    return languageLabel(code, "English");
  }

  function targetLanguageLabel(code) {
    return languageLabel(code, "Simplified Chinese");
  }

  // Categorize a translation error so callers can decide whether retrying is
  // worthwhile. "fatal" must not be retried (bad config, auth, quota);
  // "retryable" should be retried with backoff (transient network/rate-limit/
  // parsing issues); "unknown" is treated as fatal to be safe.
  const TRANSLATION_FATAL_RE =
    /API Key|not configured|base URL|model|401|403|quota|insufficient/i;
  const TRANSLATION_RETRYABLE_RE =
    /429|rate limit|too many requests|timeout|aborted|network|failed to fetch|non-JSON|empty content|did not contain usable translations|truncated|finish_reason|request failed \(5\d\d\)/i;

  function classifyTranslationError(message) {
    const text = String(message || "");
    if (!text) {
      return "unknown";
    }
    if (TRANSLATION_FATAL_RE.test(text)) {
      return "fatal";
    }
    if (TRANSLATION_RETRYABLE_RE.test(text)) {
      return "retryable";
    }
    return "unknown";
  }

  const SENTENCE_END_RE = /[.!?。！？]["')\]]?$/;
  const DISPLAY_SENTENCE_END_RE = /[.!?]["')\]]?$/;
  const DISPLAY_BREAK_WORDS = new Set([
    "actually",
    "also",
    "anyway",
    "basically",
    "but",
    "finally",
    "first",
    "however",
    "instead",
    "like",
    "meanwhile",
    "next",
    "now",
    "second",
    "seems",
    "so",
    "then",
    "well"
  ]);
  const DISPLAY_PREPOSITION_WORDS = new Set([
    "about",
    "after",
    "as",
    "at",
    "before",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "onto",
    "over",
    "than",
    "through",
    "to",
    "under",
    "with",
    "without"
  ]);
  const DISPLAY_CLAUSE_END_WORDS = new Set(["bad", "done", "fine", "good", "ok", "okay", "work", "works"]);
  const DISPLAY_DISCOURSE_WORDS = new Set(["like", "so", "but", "then", "now", "well"]);
  const DISPLAY_PRONOUN_WORDS = new Set(["i", "we", "you", "he", "she", "they", "it", "this", "that", "there"]);
  const TAG_RE = /<[^>]+>/g;

  function decodeHtmlEntities(value) {
    if (!value) {
      return "";
    }

    const named = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " "
    };

    return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower[0] === "#") {
        const isHex = lower[1] === "x";
        const raw = isHex ? lower.slice(2) : lower.slice(1);
        const code = Number.parseInt(raw, isHex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
    });
  }

  function normalizeSubtitleText(value) {
    return decodeHtmlEntities(value)
      .replace(TAG_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanDisplayWord(value) {
    return String(value || "").replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "").toLowerCase();
  }

  function capitalizeDisplaySentence(value) {
    return String(value || "")
      .replace(/\bi\b/g, "I")
      .replace(/(^|[.!?]\s+)([a-z])/g, (match, prefix, letter) => prefix + letter.toUpperCase());
  }

  function ensureDisplaySentenceEnd(value) {
    const text = String(value || "").trim();
    if (!text || DISPLAY_SENTENCE_END_RE.test(text)) {
      return text;
    }
    if (/[,;:]$/.test(text)) {
      return text.slice(0, -1) + ".";
    }
    return text + ".";
  }

  function polishDisplaySentence(value) {
    return ensureDisplaySentenceEnd(
      capitalizeDisplaySentence(value)
        .replace(/^(Like|So|Well|Now|Actually) I\b/, "$1, I")
        .replace(/^(Like|So|Well|Now|Actually) we\b/, "$1, we")
        .replace(/^(Like|So|Well|Now|Actually) you\b/, "$1, you")
    );
  }

  function findDisplayBreak(words, start, end) {
    const remaining = end - start;
    if (remaining <= 8) {
      return -1;
    }

    for (let index = start + 4; index <= end - 3; index += 1) {
      const word = cleanDisplayWord(words[index]);
      const previousWord = cleanDisplayWord(words[index - 1]);
      if ((word === "it's" || word === "it") && DISPLAY_CLAUSE_END_WORDS.has(previousWord)) {
        return index;
      }
    }

    const minOffset = 6;
    const idealOffset = 10;
    const maxOffset = 16;
    let bestIndex = -1;
    let bestScore = Infinity;

    for (let offset = minOffset; offset <= Math.min(maxOffset, remaining - 4); offset += 1) {
      const index = start + offset;
      const word = cleanDisplayWord(words[index]);
      const previousWord = cleanDisplayWord(words[index - 1]);
      if (!DISPLAY_BREAK_WORDS.has(word)) {
        continue;
      }
      if (DISPLAY_PREPOSITION_WORDS.has(previousWord)) {
        continue;
      }
      const score = Math.abs(offset - idealOffset) + (word === "seems" ? -2 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex > start) {
      return bestIndex;
    }

    for (let index = start + 2; index <= end - 4; index += 1) {
      const word = cleanDisplayWord(words[index]);
      const nextWord = cleanDisplayWord(words[index + 1]);
      const previousWord = cleanDisplayWord(words[index - 1]);
      if (DISPLAY_PREPOSITION_WORDS.has(previousWord)) {
        continue;
      }
      if (DISPLAY_DISCOURSE_WORDS.has(word) && DISPLAY_PRONOUN_WORDS.has(nextWord)) {
        return index;
      }
    }

    return -1;
  }

  function formatDisplaySourceText(value) {
    const text = normalizeSubtitleText(value);
    if (!text) {
      return "";
    }

    const normalized = text.replace(/\bi\b/g, "I");
    if (/[.!?]/.test(normalized)) {
      return ensureDisplaySentenceEnd(capitalizeDisplaySentence(normalized));
    }

    const words = normalized.split(" ");
    const sentences = [];
    let start = 0;
    while (start < words.length) {
      const breakIndex = findDisplayBreak(words, start, words.length);
      if (breakIndex > start) {
        sentences.push(words.slice(start, breakIndex).join(" "));
        start = breakIndex;
      } else {
        sentences.push(words.slice(start).join(" "));
        break;
      }
    }

    return sentences
      .map(polishDisplaySentence)
      .filter(Boolean)
      .join(" ");
  }

  function cueTextFromSegments(segments) {
    if (!Array.isArray(segments)) {
      return "";
    }

    return normalizeSubtitleText(
      segments
        .map((segment) => (segment && typeof segment.utf8 === "string" ? segment.utf8 : ""))
        .join("")
    );
  }

  function parseJson3Captions(json) {
    if (!json || !Array.isArray(json.events)) {
      return [];
    }

    const cues = [];
    for (const event of json.events) {
      const text = cueTextFromSegments(event.segs);
      if (!text) {
        continue;
      }

      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs);
      if (!Number.isFinite(startMs)) {
        continue;
      }

      cues.push({
        startMs: Math.max(0, startMs),
        endMs: Math.max(startMs + 1, startMs + (Number.isFinite(durationMs) ? durationMs : 1500)),
        sourceText: text
      });
    }

    for (let index = 0; index < cues.length - 1; index += 1) {
      if (cues[index].endMs > cues[index + 1].startMs) {
        cues[index].endMs = Math.max(cues[index].startMs + 1, cues[index + 1].startMs);
      }
    }

    return cues;
  }

  function parseVttTime(value) {
    const match = String(value).trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
    if (!match) {
      return NaN;
    }

    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const millis = Number(match[4]);
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
  }

  function parseVttCaptions(text) {
    const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
    const cues = [];
    let index = 0;

    while (index < lines.length) {
      let line = lines[index].trim();
      if (!line || line === "WEBVTT" || line.startsWith("NOTE")) {
        index += 1;
        continue;
      }

      if (!line.includes("-->") && index + 1 < lines.length && lines[index + 1].includes("-->")) {
        index += 1;
        line = lines[index].trim();
      }

      if (!line.includes("-->")) {
        index += 1;
        continue;
      }

      const [startRaw, endRaw] = line.split("-->");
      const startMs = parseVttTime(startRaw);
      const endMs = parseVttTime(endRaw.trim().split(/\s+/)[0]);
      index += 1;

      const textLines = [];
      while (index < lines.length && lines[index].trim()) {
        textLines.push(lines[index]);
        index += 1;
      }

      const cueText = normalizeSubtitleText(textLines.join(" "));
      if (cueText && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        cues.push({ startMs, endMs, sourceText: cueText });
      }
    }

    return cues;
  }

  function readXmlAttribute(attrs, name) {
    const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i");
    const match = String(attrs || "").match(pattern);
    return match ? match[1] : "";
  }

  function secondsToMs(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number * 1000 : NaN;
  }

  function millisToMs(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function timeExpressionToMs(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return NaN;
    }
    if (/^\d+(?:\.\d+)?ms$/i.test(raw)) {
      return Number(raw.replace(/ms$/i, ""));
    }
    if (/^\d+(?:\.\d+)?s$/i.test(raw)) {
      return Number(raw.replace(/s$/i, "")) * 1000;
    }
    if (raw.includes(":")) {
      return parseVttTime(raw);
    }
    return secondsToMs(raw);
  }

  function parseXmlCaptions(text) {
    const input = String(text || "");
    const cues = [];

    const transcriptTextRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = transcriptTextRe.exec(input))) {
      const attrs = match[1];
      const startMs = secondsToMs(readXmlAttribute(attrs, "start"));
      const durationMs = secondsToMs(readXmlAttribute(attrs, "dur"));
      const sourceText = normalizeSubtitleText(match[2]);
      if (sourceText && Number.isFinite(startMs)) {
        cues.push({
          startMs,
          endMs: Math.max(startMs + 1, startMs + (Number.isFinite(durationMs) ? durationMs : 1500)),
          sourceText
        });
      }
    }

    if (!cues.length) {
      const paragraphRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
      while ((match = paragraphRe.exec(input))) {
      const attrs = match[1];
      const tAttr = readXmlAttribute(attrs, "t");
      const dAttr = readXmlAttribute(attrs, "d");
      const startMs = tAttr ? millisToMs(tAttr) : timeExpressionToMs(readXmlAttribute(attrs, "begin"));
      const durationMs = dAttr ? millisToMs(dAttr) : timeExpressionToMs(readXmlAttribute(attrs, "dur"));
      const explicitEndMs = timeExpressionToMs(readXmlAttribute(attrs, "end"));
      const sourceText = normalizeSubtitleText(match[2]);
      if (sourceText && Number.isFinite(startMs)) {
        cues.push({
          startMs,
          endMs: Math.max(
            startMs + 1,
            Number.isFinite(explicitEndMs)
              ? explicitEndMs
              : startMs + (Number.isFinite(durationMs) ? durationMs : 1500)
          ),
          sourceText
        });
      }
      }
    }

    return cues.sort((left, right) => left.startMs - right.startMs);
  }

  function runsToText(runs) {
    if (!Array.isArray(runs)) {
      return "";
    }
    return normalizeSubtitleText(runs.map((run) => (run && run.text) || "").join(""));
  }

  function collectTranscriptSegments(value, segments, depth) {
    if (!value || depth > 24) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectTranscriptSegments(item, segments, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (value.transcriptSegmentRenderer) {
      const segment = value.transcriptSegmentRenderer;
      const startMs = Number(segment.startMs);
      const endMs = Number(segment.endMs);
      const sourceText = runsToText(segment.snippet && segment.snippet.runs);
      if (sourceText && Number.isFinite(startMs)) {
        segments.push({
          startMs,
          endMs: Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + 1500,
          sourceText
        });
      }
    }

    for (const item of Object.values(value)) {
      collectTranscriptSegments(item, segments, depth + 1);
    }
  }

  function parseYouTubeTranscriptResponse(json) {
    const cues = [];
    collectTranscriptSegments(json, cues, 0);
    return cues.sort((left, right) => left.startMs - right.startMs);
  }

  function findYouTubeTranscriptParams(value, depth) {
    if (!value || depth > 24) {
      return "";
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const params = findYouTubeTranscriptParams(item, depth + 1);
        if (params) {
          return params;
        }
      }
      return "";
    }

    if (typeof value !== "object") {
      return "";
    }

    if (
      value.getTranscriptEndpoint &&
      typeof value.getTranscriptEndpoint.params === "string"
    ) {
      return value.getTranscriptEndpoint.params;
    }

    for (const item of Object.values(value)) {
      const params = findYouTubeTranscriptParams(item, depth + 1);
      if (params) {
        return params;
      }
    }

    return "";
  }

  function createMergedCue(rawCues, startIndex, endIndex, text) {
    const first = rawCues[startIndex];
    const last = rawCues[endIndex];
    return {
      id: String(startIndex),
      startMs: first.startMs,
      endMs: last.endMs,
      sourceText: text,
      displaySourceText: formatDisplaySourceText(text),
      translatedText: "",
      status: "pending"
    };
  }

  function mergeCaptionFragments(cues, options) {
    const settings = Object.assign(
      {
        maxGapMs: 800,
        maxDurationMs: 8000,
        maxChars: 120
      },
      options || {}
    );

    const normalized = (Array.isArray(cues) ? cues : [])
      .map((cue) => ({
        startMs: Number(cue.startMs),
        endMs: Number(cue.endMs),
        sourceText: normalizeSubtitleText(cue.sourceText || cue.displaySourceText || "")
      }))
      .filter((cue) => cue.sourceText && Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs))
      .sort((left, right) => left.startMs - right.startMs);

    const merged = [];
    let groupStart = -1;
    let groupEnd = -1;
    let groupText = "";

    function flush() {
      if (groupStart >= 0 && groupText) {
        merged.push(createMergedCue(normalized, groupStart, groupEnd, groupText));
      }
      groupStart = -1;
      groupEnd = -1;
      groupText = "";
    }

    for (let index = 0; index < normalized.length; index += 1) {
      const cue = normalized[index];
      if (groupStart < 0) {
        groupStart = index;
        groupEnd = index;
        groupText = cue.sourceText;
        if (SENTENCE_END_RE.test(groupText)) {
          flush();
        }
        continue;
      }

      const previous = normalized[groupEnd];
      const gapMs = cue.startMs - previous.endMs;
      const combinedText = `${groupText} ${cue.sourceText}`.replace(/\s+/g, " ").trim();
      const combinedDuration = cue.endMs - normalized[groupStart].startMs;
      const shouldBreakBefore =
        gapMs > settings.maxGapMs ||
        combinedDuration > settings.maxDurationMs ||
        combinedText.length > settings.maxChars ||
        SENTENCE_END_RE.test(groupText);

      if (shouldBreakBefore) {
        flush();
        groupStart = index;
        groupEnd = index;
        groupText = cue.sourceText;
      } else {
        groupEnd = index;
        groupText = combinedText;
      }

      if (SENTENCE_END_RE.test(groupText)) {
        flush();
      }
    }

    flush();
    return merged.map((cue, index) => Object.assign({}, cue, { id: String(index) }));
  }

  function findCueAtTime(cues, timeMs) {
    if (!Array.isArray(cues) || !Number.isFinite(timeMs)) {
      return null;
    }

    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const cue = cues[middle];
      if (timeMs < cue.startMs) {
        high = middle - 1;
      } else if (timeMs >= cue.endMs) {
        low = middle + 1;
      } else {
        return cue;
      }
    }

    return null;
  }

  function fingerprintText(value) {
    const input = String(value || "");
    let hash = 5381;
    for (let index = 0; index < input.length; index += 1) {
      hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
      hash >>>= 0;
    }
    return hash.toString(36);
  }

  function makeCacheKey(parts) {
    const safeParts = Array.isArray(parts) ? parts : [];
    return `ytbt:${fingerprintText(safeParts.join("|"))}`;
  }

  function buildChatCompletionsUrl(baseUrl) {
    const raw = String(baseUrl || "").trim();
    if (!raw) {
      return "";
    }

    const trimmed = raw.replace(/\/+$/, "");
    return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
  }

  function resolveTranslationConfig(settings) {
    const source = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const provider = source.translationProvider === "custom" ? "custom" : "deepseek";
    const apiKey = String(source.translationApiKey || source.deepseekApiKey || "").trim();
    const baseUrl = String(
      source.translationBaseUrl || (provider === "deepseek" ? DEEPSEEK_BASE_URL : "")
    ).trim();
    const model = String(
      source.translationModel || (provider === "deepseek" ? DEEPSEEK_MODEL : "")
    ).trim();

    return {
      provider,
      providerLabel: provider === "deepseek" ? "DeepSeek" : "Custom API",
      apiKey,
      baseUrl,
      chatCompletionsUrl: buildChatCompletionsUrl(baseUrl),
      model,
      useJsonResponseFormat: source.translationJsonResponse !== false,
      includeDeepSeekThinkingFlag: provider === "deepseek"
    };
  }

  function parseDeepSeekTranslationContent(content) {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const items = [];

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const id = item && item.id != null ? String(item.id) : "";
        const translatedText = normalizeSubtitleText(
          item && (item.translatedText || item.translation || item.text || item.zh)
        );
        const displaySourceText = formatDisplaySourceText(
          item && (item.displaySourceText || item.punctuatedSourceText || item.sourceDisplayText)
        );
        if (id && translatedText) {
          const result = { id, translatedText };
          if (displaySourceText) {
            result.displaySourceText = displaySourceText;
          }
          items.push(result);
        }
      }
      return items;
    }

    if (!parsed || typeof parsed !== "object") {
      return items;
    }

    const list = Array.isArray(parsed.items)
      ? parsed.items
      : Array.isArray(parsed.translations)
        ? parsed.translations
        : null;

    if (list) {
      return parseDeepSeekTranslationContent(list);
    }

    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const translatedText = normalizeSubtitleText(value);
        if (translatedText) {
          items.push({ id: String(id), translatedText });
        }
      }
    }

    return items;
  }

  const api = {
    DEFAULT_SETTINGS,
    DEEPSEEK_MODEL,
    DEEPSEEK_BASE_URL,
    MERGE_VERSION,
    DEFAULT_CACHE_MAX_ITEMS,
    decodeHtmlEntities,
    normalizeSubtitleText,
    formatDisplaySourceText,
    sourceLanguageLabel,
    targetLanguageLabel,
    classifyTranslationError,
    parseJson3Captions,
    parseVttCaptions,
    parseVttTime,
    parseXmlCaptions,
    parseYouTubeTranscriptResponse,
    findYouTubeTranscriptParams,
    mergeCaptionFragments,
    findCueAtTime,
    fingerprintText,
    makeCacheKey,
    buildChatCompletionsUrl,
    resolveTranslationConfig,
    parseDeepSeekTranslationContent
  };

  root.YTBTCore = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
