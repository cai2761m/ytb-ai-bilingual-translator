(function runOptionsPage() {
  "use strict";

  const Core = globalThis.YTBTCore;
  const form = document.querySelector("#settings-form");
  const apiKeyInput = document.querySelector("#deepseekApiKey");
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
    apiKeyInput.value = settings.deepseekApiKey || "";
    sourceLanguage.value = settings.sourceLanguage || Core.DEFAULT_SETTINGS.sourceLanguage;
    targetLanguage.value = settings.targetLanguage || Core.DEFAULT_SETTINGS.targetLanguage;
    fontScale.value = settings.fontScale || Core.DEFAULT_SETTINGS.fontScale;
    subtitleEnabled.checked = settings.subtitleEnabled !== false;
    updateFontScaleLabel();

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
    await storageSet({
      deepseekApiKey: apiKeyInput.value.trim(),
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

  function showStatus(message) {
    status.textContent = message;
    setTimeout(() => {
      if (status.textContent === message) {
        status.textContent = "";
      }
    }, 2400);
  }
})();
