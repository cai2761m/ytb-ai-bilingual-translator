(function runImmersiveTranslator() {
  "use strict";

  const Core = globalThis.YTBTCore;
  if (!Core || !globalThis.chrome || !chrome.runtime || window.top !== window) {
    return;
  }

  const BLOCK_SELECTOR = [
    "article h1",
    "article h2",
    "article h3",
    "article h4",
    "article p",
    "article li",
    "article blockquote",
    "main h1",
    "main h2",
    "main h3",
    "main h4",
    "main p",
    "main li",
    "main blockquote",
    "[role='main'] h1",
    "[role='main'] h2",
    "[role='main'] h3",
    "[role='main'] h4",
    "[role='main'] p",
    "[role='main'] li",
    "[role='main'] blockquote",
    "body > h1",
    "body > h2",
    "body > h3",
    "body > h4",
    "body > p",
    "body > ul > li",
    "body > ol > li",
    "figcaption",
    "dd"
  ].join(",");
  const SKIP_SELECTOR = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "pre",
    "code",
    "button",
    "input",
    "textarea",
    "select",
    "nav",
    "header",
    "footer",
    "form",
    "[contenteditable='true']",
    "[aria-hidden='true']",
    "[data-ytbt-immersive-root]",
    "[data-ytbt-immersive-translation]"
  ].join(",");
  const MAX_BLOCKS = 80;
  const MIN_TEXT_LENGTH = 24;
  const MAX_TEXT_LENGTH = 4000;
  const BATCH_SIZE = 8;
  const BATCH_CHAR_LIMIT = 7000;
  const MESSAGE_TIMEOUT_MS = 180000;
  const DEFAULT_BALL_TOP_PCT = 50;
  const BALL_EDGE_PADDING_PX = 8;
  const BALL_DRAG_THRESHOLD_PX = 4;

  const state = {
    ball: null,
    ballText: null,
    panel: null,
    panelTimer: null,
    mode: "idle",
    visible: true,
    translated: false,
    runToken: 0,
    ballTopPct: DEFAULT_BALL_TOP_PCT,
    ballDrag: {
      pointerId: null,
      startClientY: 0,
      lastClientY: 0,
      offsetY: 0,
      active: false,
      suppressClick: false
    }
  };

  init();

  function init() {
    const root = document.documentElement;
    if (!root || root.dataset.ytbtImmersiveReady === "true") {
      return;
    }
    root.dataset.ytbtImmersiveReady = "true";

    if (document.body) {
      mountControls();
    } else {
      document.addEventListener("DOMContentLoaded", mountControls, { once: true });
    }
  }

  function mountControls() {
    if (state.ball || !document.body) {
      return;
    }

    const ballContainer = document.createElement("div");
    ballContainer.className = "ytbt-immersive-tab";
    ballContainer.dataset.ytbtImmersiveRoot = "true";

    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = "ytbt-immersive-ball";
    ball.setAttribute("aria-label", "Immersive translate");
    ball.title = "Immersive translate";

    ball.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
    </svg>`;
    
    ballContainer.appendChild(ball);

    const panel = document.createElement("div");
    panel.className = "ytbt-immersive-panel";
    panel.dataset.ytbtImmersiveRoot = "true";
    panel.hidden = true;
    panel.setAttribute("role", "status");

    ballContainer.addEventListener("pointerdown", handleBallPointerDown, true);
    ballContainer.addEventListener("click", handleBallClick);
    document.body.appendChild(ballContainer);
    document.body.appendChild(panel);

    state.ball = ballContainer;
    state.ballText = null;
    state.panel = panel;
    loadBallPosition();
    updateBallMode("idle");
  }

  async function handleBallClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (state.ballDrag.suppressClick) {
      state.ballDrag.suppressClick = false;
      return;
    }

    if (state.mode === "translating") {
      showStatus("Translation is already running...", true);
      return;
    }

    if (state.translated) {
      state.visible = !state.visible;
      document.documentElement.classList.toggle("ytbt-immersive-hidden", !state.visible);
      showStatus(state.visible ? "Bilingual translations shown." : "Bilingual translations hidden.");
      updateBallMode(state.visible ? "done" : "idle");
      return;
    }

    await translateCurrentPage();
  }

  function handleBallPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (state.ballDrag.pointerId != null) {
      cancelBallDrag();
    }

    const rect = state.ball.getBoundingClientRect();
    state.ballDrag.pointerId = event.pointerId;
    state.ballDrag.startClientX = event.clientX;
    state.ballDrag.startClientY = event.clientY;
    state.ballDrag.offsetY = event.clientY - rect.top;
    state.ballDrag.startRight = parseFloat(window.getComputedStyle(state.ball).right) || 0;
    state.ballDrag.active = false;

    state.ball.setPointerCapture(event.pointerId);
    document.addEventListener("pointermove", handleBallPointerMove, true);
    document.addEventListener("pointerup", handleBallPointerUp, true);
    document.addEventListener("pointercancel", handleBallPointerCancel, true);
  }

  function handleBallPointerMove(event) {
    const drag = state.ballDrag;
    if (drag.pointerId !== event.pointerId) {
      return;
    }

    const distanceX = Math.abs(event.clientX - drag.startClientX);
    const distanceY = Math.abs(event.clientY - drag.startClientY);
    if (!drag.active && (distanceX >= BALL_DRAG_THRESHOLD_PX || distanceY >= BALL_DRAG_THRESHOLD_PX)) {
      drag.active = true;
      state.ball.classList.add("ytbt-immersive-dragging");
    }

    if (!drag.active) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    moveBallToClient(event.clientX, event.clientY);
  }

  function handleBallPointerUp(event) {
    const drag = state.ballDrag;
    if (drag.pointerId !== event.pointerId) {
      return;
    }

    if (drag.active) {
      event.preventDefault();
      event.stopPropagation();
      drag.suppressClick = true;
      state.ball.style.right = "0px";
      saveBallPosition();
    }
    cancelBallDrag();
  }

  function handleBallPointerCancel(event) {
    if (event && state.ballDrag.pointerId !== event.pointerId) {
      return;
    }
    if (state.ballDrag.active && state.ball) {
      state.ball.style.right = "0px";
    }
    cancelBallDrag();
  }

  function cancelBallDrag() {
    if (state.ball && state.ballDrag.pointerId != null) {
      try {
        state.ball.releasePointerCapture(state.ballDrag.pointerId);
      } catch (error) {
        // Ignore browsers that already released the pointer.
      }
      state.ball.classList.remove("ytbt-immersive-dragging");
    }

    document.removeEventListener("pointermove", handleBallPointerMove, true);
    document.removeEventListener("pointerup", handleBallPointerUp, true);
    document.removeEventListener("pointercancel", handleBallPointerCancel, true);

    state.ballDrag.pointerId = null;
    state.ballDrag.active = false;
  }

  function moveBallToClient(clientX, clientY) {
    if (!state.ball) {
      return;
    }

    const rect = state.ball.getBoundingClientRect();
    const halfHeight = rect.height / 2 || 16;
    const minCenterY = BALL_EDGE_PADDING_PX + halfHeight;
    const maxCenterY = window.innerHeight - BALL_EDGE_PADDING_PX - halfHeight;
    const rawCenterY = clientY - state.ballDrag.offsetY + halfHeight;
    const centerY = clamp(rawCenterY, Math.min(minCenterY, maxCenterY), Math.max(minCenterY, maxCenterY));

    state.ballTopPct = (centerY / Math.max(1, window.innerHeight)) * 100;
    
    let newRight = state.ballDrag.startRight - (clientX - state.ballDrag.startClientX);
    newRight = clamp(newRight, 0, window.innerWidth - rect.width);
    state.ball.style.right = `${newRight}px`;
    
    applyBallPosition();
  }

  function applyBallPosition() {
    const topPct = clamp(Number(state.ballTopPct) || DEFAULT_BALL_TOP_PCT, 4, 96);
    state.ballTopPct = topPct;

    if (state.ball) {
      state.ball.style.top = `${topPct}%`;
    }
    if (state.panel) {
      state.panel.style.top = `min(calc(${topPct}% + 24px), calc(100vh - 64px))`;
    }
  }

  async function loadBallPosition() {
    try {
      const values = await storageGet({ immersiveBallTopPct: DEFAULT_BALL_TOP_PCT });
      state.ballTopPct = normalizeBallTopPct(values.immersiveBallTopPct);
      applyBallPosition();
    } catch (error) {
      applyBallPosition();
    }
  }

  async function saveBallPosition() {
    const topPct = normalizeBallTopPct(state.ballTopPct);
    state.ballTopPct = topPct;
    applyBallPosition();
    try {
      await storageSet({ immersiveBallTopPct: topPct });
    } catch (error) {
      // Position persistence is nice-to-have; dragging should still work.
    }
  }

  function normalizeBallTopPct(value) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, 4, 96) : DEFAULT_BALL_TOP_PCT;
  }

  async function translateCurrentPage() {
    const blocks = collectBlocks();
    if (!blocks.length) {
      updateBallMode("idle");
      showStatus("No readable English text found on this page.");
      return;
    }

    const token = (state.runToken += 1);
    state.translated = false;
    state.visible = true;
    document.documentElement.classList.remove("ytbt-immersive-hidden");
    updateBallMode("translating");
    showStatus(`Translating 0/${blocks.length} blocks...`, true);

    for (const block of blocks) {
      block.container = createTranslationContainer(block);
    }

    let translatedCount = 0;
    try {
      const batches = makeBatches(blocks);
      for (const batch of batches) {
        if (token !== state.runToken) {
          return;
        }

        const items = await translateBatch(batch);
        const translatedById = new Map();
        for (const item of items) {
          if (item && item.id != null && item.translatedText) {
            translatedById.set(String(item.id), Core.normalizeSubtitleText(item.translatedText));
          }
        }

        for (const block of batch) {
          const translatedText = translatedById.get(block.id);
          if (translatedText) {
            renderTranslation(block, translatedText);
          } else {
            renderTranslationError(block, "Translation missing for this block.");
          }
          translatedCount += 1;
        }

        showStatus(`Translating ${translatedCount}/${blocks.length} blocks...`, true);
      }

      state.translated = true;
      updateBallMode("done");
      showStatus(`Done. Added ${translatedCount} bilingual translations.`);
    } catch (error) {
      updateBallMode("error");
      const message = error && error.message ? error.message : String(error);
      for (const block of blocks) {
        if (block.container && block.container.dataset.ytbtState === "loading") {
          renderTranslationError(block, message);
        }
      }
      showStatus(`Translation failed: ${message}`, true);
    }
  }

  function collectBlocks() {
    const candidates = Array.from(document.querySelectorAll(BLOCK_SELECTOR));
    const blocks = [];

    for (const element of candidates) {
      if (blocks.length >= MAX_BLOCKS) {
        break;
      }
      if (!isUsableBlock(element)) {
        continue;
      }

      const text = extractReadableText(element);
      if (!looksLikeEnglishText(text)) {
        continue;
      }

      const id = `im${blocks.length}`;
      element.dataset.ytbtImmersiveSource = id;
      element.classList.add("ytbt-immersive-source");
      blocks.push({ id, element, sourceText: text });
    }

    return blocks;
  }

  function isUsableBlock(element) {
    if (!element || element.closest(SKIP_SELECTOR)) {
      return false;
    }
    if (element.querySelector(BLOCK_SELECTOR)) {
      return false;
    }
    if (element.closest(".ytp-caption-window-container, .caption-window, .ytbt-overlay")) {
      return false;
    }
    if (!isVisible(element)) {
      return false;
    }
    return true;
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function extractReadableText(element) {
    const clone = element.cloneNode(true);
    for (const injected of clone.querySelectorAll("[data-ytbt-immersive-translation]")) {
      injected.remove();
    }

    const text = Core.normalizeSubtitleText(clone.textContent || "");
    if (text.length > MAX_TEXT_LENGTH) {
      return "";
    }
    return text;
  }

  function looksLikeEnglishText(text) {
    if (!text || text.length < MIN_TEXT_LENGTH) {
      return false;
    }
    if (!/[A-Za-z]/.test(text)) {
      return false;
    }
    if (/^https?:\/\//i.test(text) || /^[\d\s.,:;!?()[\]{}'"`~@#$%^&*_+=|\\/-]+$/.test(text)) {
      return false;
    }

    const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    return words.length >= 5;
  }

  function createTranslationContainer(block) {
    const previous = document.querySelector(`[data-ytbt-immersive-for="${block.id}"]`);
    if (previous) {
      previous.remove();
    }

    const container = document.createElement("span");
    container.className = "ytbt-immersive-translation";
    container.dataset.ytbtImmersiveTranslation = "true";
    container.dataset.ytbtImmersiveFor = block.id;
    container.dataset.ytbtState = "loading";

    const text = document.createElement("span");
    text.className = "ytbt-immersive-text";
    text.textContent = "Translating...";

    container.appendChild(text);
    block.element.appendChild(container);

    return container;
  }

  function renderTranslation(block, translatedText) {
    const container = block.container;
    if (!container) {
      return;
    }
    const text = container.querySelector(".ytbt-immersive-text");
    if (text) {
      text.textContent = translatedText;
    }
    container.dataset.ytbtState = "done";
  }

  function renderTranslationError(block, message) {
    const container = block.container;
    if (!container) {
      return;
    }
    const text = container.querySelector(".ytbt-immersive-text");
    if (text) {
      text.textContent = message || "Translation failed.";
    }
    container.dataset.ytbtState = "error";
  }

  function makeBatches(blocks) {
    const batches = [];
    let current = [];
    let currentChars = 0;

    for (const block of blocks) {
      const textLength = block.sourceText.length;
      const wouldOverflow =
        current.length >= BATCH_SIZE ||
        (current.length > 0 && currentChars + textLength > BATCH_CHAR_LIMIT);
      if (wouldOverflow) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }

      current.push(block);
      currentChars += textLength;
    }

    if (current.length) {
      batches.push(current);
    }

    return batches;
  }

  async function translateBatch(batch) {
    const response = await sendMessage({
      type: "IMMERSIVE_TRANSLATE",
      pageUrl: location.href,
      items: batch.map((block) => ({
        id: block.id,
        sourceText: block.sourceText
      }))
    });

    if (!response || response.ok === false) {
      const error = response && response.errors && response.errors[0];
      throw new Error(error && error.message ? error.message : "Translation request failed.");
    }

    return Array.isArray(response.items) ? response.items : [];
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        reject(new Error("Translation request timeout."));
      }, MESSAGE_TIMEOUT_MS);

      chrome.runtime.sendMessage(message, (response) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);

        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function updateBallMode(mode) {
    state.mode = mode;
    if (!state.ball) {
      return;
    }
    state.ball.dataset.ytbtState = mode;
  }

  function showStatus(message, persistent) {
    if (!state.panel) {
      return;
    }

    state.panel.textContent = message;
    state.panel.hidden = false;

    if (state.panelTimer) {
      clearTimeout(state.panelTimer);
      state.panelTimer = null;
    }

    if (!persistent) {
      state.panelTimer = setTimeout(() => {
        if (state.panel) {
          state.panel.hidden = true;
        }
      }, 3600);
    }
  }
})();
