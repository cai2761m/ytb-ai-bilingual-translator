importScripts("shared.js");

const Core = globalThis.YTBTCore;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_PREFIX = "ytbt:";
// In-memory count of cached cue translations so we usually avoid a full storage
// scan on every write. Reset on service-worker restart; refreshed on demand.
let cachedItemCount = null;

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "TRANSLATE_BATCH") {
    return false;
  }

  handleTranslateBatch(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        type: "TRANSLATE_RESULT",
        ok: false,
        videoId: message.videoId,
        items: [],
        errors: [{ message: error && error.message ? error.message : String(error) }]
      });
    });

  return true;
});

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function handleTranslateBatch(message) {
  const settings = await storageGet(Core.DEFAULT_SETTINGS);
  const targetLanguage = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
  const sourceLanguage = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
  const asrCorrectionEnabled = settings.asrCorrectionEnabled !== false;
  const translationConfig = Core.resolveTranslationConfig(settings);

  if (!translationConfig.apiKey) {
    return {
      type: "TRANSLATE_RESULT",
      ok: false,
      videoId: message.videoId,
      batchId: message.batchId,
      items: [],
      errors: [{ code: "missing_api_key", message: `${translationConfig.providerLabel} API Key is not configured.` }]
    };
  }

  const endpointUrl =
    translationConfig.apiStyle === "gemini"
      ? translationConfig.generateContentUrl
      : translationConfig.chatCompletionsUrl;
  if (!endpointUrl || !translationConfig.model) {
    return {
      type: "TRANSLATE_RESULT",
      ok: false,
      videoId: message.videoId,
      batchId: message.batchId,
      items: [],
      errors: [{ code: "missing_provider_config", message: `${translationConfig.providerLabel} base URL or model is not configured.` }]
    };
  }

  const cues = Array.isArray(message.cues) ? message.cues : [];
  const legacyCacheKeyParts = [
    message.videoId || "",
    message.trackFingerprint || "",
    translationConfig.provider,
    endpointUrl,
    translationConfig.model,
    targetLanguage,
    Core.MERGE_VERSION,
    settings.cacheVersion || "1"
  ];
  const correctedCacheKeyParts = legacyCacheKeyParts.slice(0, 5).concat([
    sourceLanguage,
    targetLanguage,
    "asr-correction-on",
    Core.MERGE_VERSION,
    settings.cacheVersion || "1"
  ]);
  const cacheKey = Core.makeCacheKey(asrCorrectionEnabled ? correctedCacheKeyParts : legacyCacheKeyParts);

  const cache = await storageGet({ [cacheKey]: { items: {}, updatedAt: 0 } });
  const cacheValue = cache[cacheKey] || { items: {} };
  const cachedItems = [];
  const missingCues = [];

  for (const cue of cues) {
    const id = cue && cue.id != null ? String(cue.id) : "";
    if (!id) {
      continue;
    }
    const cachedValue = cacheValue.items && cacheValue.items[id];
    const cachedText =
      typeof cachedValue === "string"
        ? cachedValue
        : cachedValue != null && typeof cachedValue === "object"
          ? cachedValue.translatedText
          : "";
    if (cachedText) {
      const cachedItem = { id, translatedText: cachedText, cached: true };
      if (cachedValue && typeof cachedValue === "object" && cachedValue.displaySourceText) {
        cachedItem.displaySourceText = cachedValue.displaySourceText;
      }
      cachedItems.push(cachedItem);
    } else {
      missingCues.push({
        id,
        sourceText: Core.normalizeSubtitleText(cue.sourceText || cue.displaySourceText || "")
      });
    }
  }

  if (!missingCues.length) {
    return {
      type: "TRANSLATE_RESULT",
      ok: true,
      videoId: message.videoId,
      batchId: message.batchId,
      items: cachedItems,
      errors: []
    };
  }

  const translatedItems = await translateWithRetry({
    translationConfig,
    targetLanguage,
    sourceLanguage,
    asrCorrectionEnabled,
    cues: missingCues
  });

  const mergedCacheItems = Object.assign({}, cacheValue.items || {});
  for (const item of translatedItems) {
    mergedCacheItems[item.id] = item.displaySourceText
      ? { translatedText: item.translatedText, displaySourceText: item.displaySourceText }
      : item.translatedText;
  }

  await persistTranslationCache({
    cacheKey,
    cacheValue: {
      items: mergedCacheItems,
      updatedAt: Date.now(),
      provider: translationConfig.provider,
      model: translationConfig.model,
      baseUrl: translationConfig.baseUrl,
      targetLanguage,
      sourceLanguage,
      asrCorrectionEnabled
    },
    addedCount: translatedItems.length,
    maxItems: Number(settings.translationCacheMaxItems) || Core.DEFAULT_CACHE_MAX_ITEMS
  });

  return {
    type: "TRANSLATE_RESULT",
    ok: true,
    videoId: message.videoId,
    batchId: message.batchId,
    items: cachedItems.concat(translatedItems),
    errors: []
  };
}

async function translateWithRetry(request) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await translateBatch(request);
    } catch (error) {
      lastError = error;
      const message = (error && error.message) || String(error);
      // Fatal / unknown errors (bad config, auth, quota, unparseable shapes)
      // should not waste retry budget; only retry transient failures.
      if (Core.classifyTranslationError(message) !== "retryable") {
        throw error;
      }
      if (attempt < MAX_RETRIES) {
        const retryDelayMs = retryDelayForError(message, request.translationConfig, attempt);
        if (!retryDelayMs) {
          throw error;
        }
        await delay(retryDelayMs);
      }
    }
  }
  throw lastError;
}

function retryDelayForError(message, translationConfig, attempt) {
  const text = String(message || "");
  if (translationConfig && translationConfig.apiStyle === "gemini") {
    if (/429|TooManyRequests|too many requests|rate limit/i.test(text)) {
      return 0;
    }
    if (/503|ServiceUnavailable|unavailable/i.test(text)) {
      return 8000 * Math.pow(2, attempt);
    }
  }

  const base = /429|rate limit|too many requests/i.test(text) ? 15000 : 500;
  return base * Math.pow(2, attempt);
}

async function translateBatch({ translationConfig, sourceLanguage, targetLanguage, asrCorrectionEnabled, cues }) {
  const sourceLabel = Core.sourceLanguageLabel(sourceLanguage);
  const targetLabel = Core.targetLanguageLabel(targetLanguage);
  // Allow roughly 200 output tokens per cue so longer batches are not silently
  // truncated. Bounded to a sane [2048, 8000] range.
  const maxTokens = Math.min(8000, Math.max(2048, cues.length * 200));
  const sourcePolishInstruction = asrCorrectionEnabled
    ? "Before translating, correct only obvious ASR recognition mistakes in the source using nearby batch context: wrong homophones, broken word boundaries, missing small words, and clear recognition errors. Preserve technical terms, names, code identifiers, acronyms, numbers, and uncertain words exactly when unsure. "
    : "Do not rewrite the source words for ASR correction; only restore natural punctuation and capitalization. ";
  const systemPrompt =
    `You are a subtitle translation engine. Translate ${sourceLabel} subtitles into natural ${targetLabel}. ` +
    sourcePolishInstruction +
    "Keep meaning concise for on-screen reading. The displaySourceText field must contain the polished source subtitle, and translatedText must translate that polished meaning. " +
    "Return exactly one item for every input id and never skip ids. " +
    "Output json only in this exact format: " +
    "{\"items\":[{\"id\":\"0\",\"translatedText\":\"...\",\"displaySourceText\":\"...\"}]}. Do not add commentary.";
  const userPayload = {
    sourceLanguage,
    targetLanguage,
    asrCorrectionEnabled: Boolean(asrCorrectionEnabled),
    items: cues.map((cue) => ({ id: String(cue.id), text: cue.sourceText }))
  };

  let content = "";
  let finishReason = "";

  if (translationConfig.apiStyle === "gemini") {
    const payload = {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: JSON.stringify(userPayload) }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: maxTokens
      }
    };

    if (translationConfig.useJsonResponseFormat) {
      payload.generationConfig.responseMimeType = "application/json";
    }

    const response = await fetchWithTimeout(
      withApiKeyQuery(translationConfig.generateContentUrl, translationConfig.apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatProviderRequestError(translationConfig.providerLabel, response.status, bodyText));
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      throw new Error(`${translationConfig.providerLabel} returned non-JSON response.`);
    }

    const candidate = body && body.candidates && body.candidates[0];
    finishReason = candidate && candidate.finishReason;
    content = extractGeminiCandidateText(candidate);
    if (!content && body && body.promptFeedback && body.promptFeedback.blockReason) {
      throw new Error(`${translationConfig.providerLabel} returned empty content (${body.promptFeedback.blockReason}).`);
    } else if (!content && finishReason) {
      throw new Error(`${translationConfig.providerLabel} returned empty content (finish_reason=${finishReason}).`);
    }
  } else {
    const payload = {
      model: translationConfig.model,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: JSON.stringify(userPayload)
        }
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: maxTokens
    };

    if (translationConfig.useJsonResponseFormat) {
      payload.response_format = { type: "json_object" };
    }
    if (translationConfig.includeDeepSeekThinkingFlag) {
      payload.thinking = { type: "disabled" };
    }

    const response = await fetchWithTimeout(translationConfig.chatCompletionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${translationConfig.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatProviderRequestError(translationConfig.providerLabel, response.status, bodyText));
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      throw new Error(`${translationConfig.providerLabel} returned non-JSON response.`);
    }

    const choice = body && body.choices && body.choices[0];
    content =
      choice &&
      choice.message &&
      choice.message.content;
    finishReason = choice && choice.finish_reason;
  }

  if (!content) {
    throw new Error(`${translationConfig.providerLabel} returned empty content.`);
  }

  // Detect token-limit truncation so the caller can shrink the batch and retry,
  // instead of silently dropping cues and entering per-cue retry loops.
  if (finishReason === "length" || finishReason === "MAX_TOKENS") {
    throw new Error(
      `${translationConfig.providerLabel} response truncated (finish_reason=${finishReason}); will retry in smaller batches.`
    );
  }

  const items = Core.parseDeepSeekTranslationContent(content);
  const expectedIds = new Set(cues.map((cue) => String(cue.id)));
  const filtered = items.filter((item) => expectedIds.has(String(item.id)));

  if (!filtered.length) {
    throw new Error(`${translationConfig.providerLabel} response did not contain usable translations.`);
  }

  return filtered;
}

function withApiKeyQuery(url, apiKey) {
  const separator = String(url || "").includes("?") ? "&" : "?";
  return `${url}${separator}key=${encodeURIComponent(apiKey)}`;
}

function formatProviderRequestError(providerLabel, status, bodyText) {
  const detail = extractProviderErrorMessage(bodyText);
  return `${providerLabel} request failed (${status}): ${detail}`;
}

function extractProviderErrorMessage(bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) {
    return "empty error response";
  }

  try {
    const body = JSON.parse(text);
    const error = body && body.error;
    if (error && typeof error.message === "string") {
      return error.message.slice(0, 300);
    }
    if (error && typeof error.status === "string") {
      return error.status.slice(0, 300);
    }
    if (body && body.promptFeedback && body.promptFeedback.blockReason) {
      return String(body.promptFeedback.blockReason).slice(0, 300);
    }
  } catch (error) {
    // Fall back to the raw text below.
  }

  return text.slice(0, 300);
}

function extractGeminiCandidateText(candidate) {
  const parts =
    candidate &&
    candidate.content &&
    Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
  return parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => {
    clearTimeout(timeout);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Write a video's translation cache back, evicting least-recently-updated video
// keys when the total cached-cue count would exceed the configured ceiling.
// Eviction granularity is per video (each `ytbt:` key), matching the natural
// "least recently watched video" semantics.
async function persistTranslationCache({ cacheKey, cacheValue, addedCount, maxItems }) {
  // Lazily initialize the in-memory count once per service-worker lifetime.
  if (cachedItemCount == null) {
    cachedItemCount = await countCachedTranslationItems();
  }

  const previousItemsInKey = Object.keys(cacheValue.items || {}).length - addedCount;
  cachedItemCount += Math.max(0, addedCount - Math.max(0, previousItemsInKey));

  if (cachedItemCount > maxItems) {
    const evicted = await evictOldestCacheKeys(cachedItemCount - maxItems, cacheKey);
    cachedItemCount -= evicted.freedItems;
  }

  try {
    await storageSet({ [cacheKey]: cacheValue });
  } catch (error) {
    // The in-memory count may have drifted (e.g. external clears). On a write
    // failure, recompute from storage and retry the eviction once before giving up.
    cachedItemCount = await countCachedTranslationItems();
    if (cachedItemCount > maxItems) {
      const evicted = await evictOldestCacheKeys(cachedItemCount - maxItems, cacheKey);
      cachedItemCount -= evicted.freedItems;
    }
    await storageSet({ [cacheKey]: cacheValue });
  }
}

// Count cached cue translations across every `ytbt:` storage key.
async function countCachedTranslationItems() {
  const all = await storageGet(null);
  let total = 0;
  for (const key of Object.keys(all)) {
    if (!key.startsWith(CACHE_PREFIX)) {
      continue;
    }
    const entry = all[key];
    if (entry && typeof entry === "object" && entry.items) {
      total += Object.keys(entry.items).length;
    }
  }
  return total;
}

// Remove oldest video cache keys until at least `itemsToFree` cue slots are
// reclaimed. The current key is never evicted. Returns how many items freed.
async function evictOldestCacheKeys(itemsToFree, currentKey) {
  if (itemsToFree <= 0) {
    return { freedItems: 0 };
  }
  const all = await storageGet(null);
  const entries = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(CACHE_PREFIX) || key === currentKey) {
      continue;
    }
    const entry = all[key];
    if (!entry || typeof entry !== "object" || !entry.items) {
      continue;
    }
    entries.push({
      key,
      updatedAt: Number(entry.updatedAt) || 0,
      itemCount: Object.keys(entry.items).length
    });
  }
  entries.sort((left, right) => left.updatedAt - right.updatedAt);

  let freed = 0;
  const removeKeys = [];
  for (const entry of entries) {
    if (freed >= itemsToFree) {
      break;
    }
    removeKeys.push(entry.key);
    freed += entry.itemCount;
  }
  if (removeKeys.length) {
    await storageRemove(removeKeys);
  }
  return { freedItems: freed };
}
