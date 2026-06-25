(function runPopup() {
  "use strict";

  const openSettings = document.querySelector("#open-settings");
  if (!openSettings) {
    return;
  }

  openSettings.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage(() => window.close());
      return;
    }

    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") }, () => {
      window.close();
    });
  });
})();
