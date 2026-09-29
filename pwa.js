/* PWA install and connectivity UI. Stock/API responses are never cached. */
(() => {
  "use strict";
  const installButton = document.getElementById("installBtn");
  const installDialog = document.getElementById("dInstall");
  const offlineBanner = document.getElementById("offlineBanner");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let installPrompt = null;

  const updateOnlineState = () => { offlineBanner.hidden = navigator.onLine; };
  updateOnlineState();
  addEventListener("online", updateOnlineState);
  addEventListener("offline", updateOnlineState);

  if (!standalone && ios) installButton.hidden = false;
  addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    if (!standalone) installButton.hidden = false;
  });
  addEventListener("appinstalled", () => { installPrompt = null; installButton.hidden = true; });

  installButton.addEventListener("click", async () => {
    if (!installPrompt) {
      if (installDialog.showModal && !installDialog.open) installDialog.showModal();
      return;
    }
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installButton.hidden = true;
  });

  if ("serviceWorker" in navigator) {
    addEventListener("load", async () => {
      try {
        const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
        registration.update();
      } catch (error) {
        console.warn("Service worker registration failed", error);
      }
    });
  }
})();
