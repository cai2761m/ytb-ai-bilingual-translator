(function runOptionsPage() {
  "use strict";

  const Core = globalThis.YTBTCore;
  const form = document.querySelector("#settings-form");
  const translationProvider = document.querySelector("#translationProvider");
  const apiKeyInput = document.querySelector("#translationApiKey");
  const translationBaseUrl = document.querySelector("#translationBaseUrl");
  const translationModel = document.querySelector("#translationModel");
  const translationJsonResponse = document.querySelector("#translationJsonResponse");
  const asrCorrectionEnabled = document.querySelector("#asrCorrectionEnabled");
  const sourceLanguage = document.querySelector("#sourceLanguage");
  const targetLanguage = document.querySelector("#targetLanguage");
  const fontScale = document.querySelector("#fontScale");
  const fontScaleValue = document.querySelector("#fontScaleValue");
  const subtitleEnabled = document.querySelector("#subtitleEnabled");
  const status = document.querySelector("#status");
  const clearCache = document.querySelector("#clear-cache");

  init();

  async function init() {
    const settings = await storageGet(Core.DEFAULT_SETTINGS);
    const config = Core.resolveTranslationConfig(settings);
    translationProvider.value = config.provider;
    apiKeyInput.value = settings.translationApiKey || settings.deepseekApiKey || "";
    translationBaseUrl.value = settings.translationBaseUrl || config.baseUrl || "";
    translationModel.value = settings.translationModel || config.model || "";
    translationJsonResponse.checked = settings.translationJsonResponse !== false;
    asrCorrectionEnabled.checked = settings.asrCorrectionEnabled !== false;
    sourceLanguage.value = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
    targetLanguage.value = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
    fontScale.value = settings.fontScale || Core.DEFAULT_SETTINGS.fontScale;
    subtitleEnabled.checked = settings.subtitleEnabled !== false;
    updateFontScaleLabel();
    updateProviderPlaceholders();

    translationProvider.addEventListener("change", handleProviderChange);
    fontScale.addEventListener("input", updateFontScaleLabel);
    form.addEventListener("submit", saveSettings);
    clearCache.addEventListener("click", clearTranslationCache);
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  async function saveSettings(event) {
    event.preventDefault();
    const apiKey = apiKeyInput.value.trim();
    const provider = translationProvider.value;
    await storageSet({
      translationProvider: provider,
      translationApiKey: apiKey,
      translationBaseUrl: translationBaseUrl.value.trim(),
      translationModel: translationModel.value.trim(),
      translationJsonResponse: translationJsonResponse.checked,
      asrCorrectionEnabled: asrCorrectionEnabled.checked,
      deepseekApiKey: provider === "deepseek" ? apiKey : "",
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
      fontScale: Number(fontScale.value),
      subtitleEnabled: subtitleEnabled.checked
    });
    showStatus("设置已保存。");
  }

  async function clearTranslationCache() {
    const all = await storageGet(null);
    const cacheKeys = Object.keys(all).filter((key) => key.startsWith("ytbt:"));
    if (cacheKeys.length) {
      await storageRemove(cacheKeys);
    }
    await storageSet({ cacheVersion: String(Date.now()) });
    showStatus(`已清空 ${cacheKeys.length} 条缓存。`);
  }

  function updateFontScaleLabel() {
    fontScaleValue.textContent = `${Number(fontScale.value || 1).toFixed(1)}x`;
  }

  function handleProviderChange() {
    if (translationProvider.value === "deepseek") {
      translationBaseUrl.value = Core.DEEPSEEK_BASE_URL;
      translationModel.value = Core.DEEPSEEK_MODEL;
    } else if (translationProvider.value === "gemini") {
      translationBaseUrl.value = Core.GEMINI_BASE_URL;
      translationModel.value = Core.GEMINI_MODEL;
    } else if (translationBaseUrl.value.trim() === Core.DEEPSEEK_BASE_URL) {
      translationBaseUrl.value = "";
      translationModel.value = "";
    } else if (translationBaseUrl.value.trim() === Core.GEMINI_BASE_URL) {
      translationBaseUrl.value = "";
      translationModel.value = "";
    }
    updateProviderPlaceholders();
  }

  function updateProviderPlaceholders() {
    if (translationProvider.value === "deepseek") {
      translationBaseUrl.placeholder = Core.DEEPSEEK_BASE_URL;
      translationModel.placeholder = Core.DEEPSEEK_MODEL;
    } else if (translationProvider.value === "gemini") {
      translationBaseUrl.placeholder = Core.GEMINI_BASE_URL;
      translationModel.placeholder = Core.GEMINI_MODEL;
    } else {
      translationBaseUrl.placeholder = "https://api.example.com/v1";
      translationModel.placeholder = "model-name";
    }
  }

  function showStatus(message) {
    status.textContent = message;
    setTimeout(() => {
      if (status.textContent === message) {
        status.textContent = "";
      }
    }, 2400);
  }
})();
