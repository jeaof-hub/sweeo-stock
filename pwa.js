/* PWA install and connectivity UI. Stock/API responses are never cached. */
(() => {
  "use strict";
  const installButton = document.getElementById("installBtn");
  const installDialog = document.getElementById("dInstall");
  const offlineBanner = document.getElementById("offlineBanner");
  const updateBanner = document.getElementById("updateBanner");
  const updateButton = document.getElementById("updateBtn");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let installPrompt = null;
  let waitingWorker = null;
  let reloadingForUpdate = false;

  const offerUpdate = worker => {
    waitingWorker = worker;
    updateBanner.hidden = false;
  };

  updateButton.addEventListener("click", () => {
    updateButton.disabled = true;
    waitingWorker?.postMessage({ type: "SKIP_WAITING" });
  });

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
        if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
          });
        });
        registration.update();
      } catch (error) {
        console.warn("Service worker registration failed", error);
      }
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      location.reload();
    });
  }
})();
