importScripts("shared.js");

const Core = globalThis.YTBTCore;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 20000;

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

async function handleTranslateBatch(message) {
  const settings = await storageGet(Core.DEFAULT_SETTINGS);
  const targetLanguage = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
  const sourceLanguage = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
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

  if (!translationConfig.chatCompletionsUrl || !translationConfig.model) {
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
  const cacheKey = Core.makeCacheKey([
    message.videoId || "",
    message.trackFingerprint || "",
    translationConfig.provider,
    translationConfig.chatCompletionsUrl,
    translationConfig.model,
    targetLanguage,
    Core.MERGE_VERSION,
    settings.cacheVersion || "1"
  ]);

  const cache = await storageGet({ [cacheKey]: { items: {}, updatedAt: 0 } });
  const cacheValue = cache[cacheKey] || { items: {} };
  const cachedItems = [];
  const missingCues = [];

  for (const cue of cues) {
    const id = cue && cue.id != null ? String(cue.id) : "";
    if (!id) {
      continue;
    }
    const cachedText = cacheValue.items && cacheValue.items[id];
    if (cachedText) {
      cachedItems.push({ id, translatedText: cachedText, cached: true });
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
    cues: missingCues
  });

  const mergedCacheItems = Object.assign({}, cacheValue.items || {});
  for (const item of translatedItems) {
    mergedCacheItems[item.id] = item.translatedText;
  }

  await storageSet({
    [cacheKey]: {
      items: mergedCacheItems,
      updatedAt: Date.now(),
      provider: translationConfig.provider,
      model: translationConfig.model,
      baseUrl: translationConfig.baseUrl,
      targetLanguage
    }
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
      if (attempt < MAX_RETRIES) {
        await delay(500 * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

async function translateBatch({ translationConfig, sourceLanguage, targetLanguage, cues }) {
  const payload = {
    model: translationConfig.model,
    messages: [
      {
        role: "system",
        content:
          "You are a subtitle translation engine. Translate English subtitles into natural Simplified Chinese. " +
          "Keep meaning concise for on-screen reading. Output json only in this exact format: " +
          "{\"items\":[{\"id\":\"0\",\"translatedText\":\"...\"}]}. Do not add commentary."
      },
      {
        role: "user",
        content: JSON.stringify({
          sourceLanguage,
          targetLanguage,
          items: cues.map((cue) => ({ id: String(cue.id), text: cue.sourceText }))
        })
      }
    ],
    stream: false,
    temperature: 0.1,
    max_tokens: 4096
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
    throw new Error(`${translationConfig.providerLabel} request failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`${translationConfig.providerLabel} returned non-JSON response.`);
  }

  const content =
    body &&
    body.choices &&
    body.choices[0] &&
    body.choices[0].message &&
    body.choices[0].message.content;

  if (!content) {
    throw new Error(`${translationConfig.providerLabel} returned empty content.`);
  }

  const items = Core.parseDeepSeekTranslationContent(content);
  const expectedIds = new Set(cues.map((cue) => String(cue.id)));
  const filtered = items.filter((item) => expectedIds.has(String(item.id)));

  if (!filtered.length) {
    throw new Error(`${translationConfig.providerLabel} response did not contain usable translations.`);
  }

  return filtered;
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
