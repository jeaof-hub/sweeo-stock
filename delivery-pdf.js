/* Lazy PDF preparation for iOS/iPadOS installed apps. */
(function (root) {
  "use strict";
  const libraries = {
    html2canvas: {
      url: "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
      integrity: "sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA=="
    },
    jspdf: {
      url: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
      integrity: "sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfcEqDTTHgtNA=="
    }
  };
  const loaded = new Map();
  function loadScript(name, ready) {
    if (ready()) return Promise.resolve();
    if (loaded.has(name)) return loaded.get(name);
    const library = libraries[name];
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = library.url;
      script.integrity = library.integrity;
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      script.onload = () => ready() ? resolve() : reject(new Error(`${name} unavailable`));
      script.onerror = () => reject(new Error(`โหลด ${name} ไม่สำเร็จ`));
      document.head.appendChild(script);
    }).catch(error => { loaded.delete(name); throw error; });
    loaded.set(name, promise);
    return promise;
  }
  function isIosStandalone(nav = navigator, media = matchMedia) {
    const ios = /iPhone|iPad|iPod/i.test(nav.userAgent || "") || (/Macintosh/i.test(nav.userAgent || "") && Number(nav.maxTouchPoints) > 1);
    const standalone = nav.standalone === true || media("(display-mode: standalone)").matches;
    return ios && standalone;
  }
  async function ensureLibraries() {
    await loadScript("html2canvas", () => typeof root.html2canvas === "function");
    await loadScript("jspdf", () => typeof root.jspdf?.jsPDF === "function");
  }
  async function createFile(container, filename) {
    await ensureLibraries();
    const pages = [...container.querySelectorAll(".sweeo-dn .delivery-page")];
    if (!pages.length) throw new Error("ไม่พบหน้าใบส่งของ");
    const pdf = new root.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
    for (let index = 0; index < pages.length; index++) {
      if (index) pdf.addPage("a4", "landscape");
      const canvas = await root.html2canvas(pages[index], { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 10, 10, 277, 190, undefined, "FAST");
    }
    const blob = pdf.output("blob");
    return new File([blob], filename, { type: "application/pdf", lastModified: Date.now() });
  }
  root.SWEEO_DELIVERY_PDF = { libraries, isIosStandalone, createFile };
})(window);
