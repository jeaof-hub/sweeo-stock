/* Role-scoped manual viewer. Manual content is fetched from get_manual() and is never persisted locally. */
(function (root) {
  "use strict";

  function safeMarkdown(markdown, markedApi, purifier) {
    if (!markedApi?.parse || !purifier?.sanitize) throw new Error("manual renderer unavailable");
    const html = markedApi.parse(String(markdown || ""), { gfm: true, breaks: false });
    return purifier.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
      FORBID_ATTR: ["style", "onerror", "onload", "onclick"]
    });
  }

  function createController({ sb, lang, dialog, content, toc, fallback, status, openButtons, menuPop, markedApi, purifier }) {
    let sections = [];
    let requestVersion = 0;

    function clear() {
      requestVersion += 1;
      sections = [];
      content.replaceChildren();
      toc.replaceChildren();
      fallback.hidden = true;
      status.textContent = "";
      if (dialog.open) dialog.close();
    }

    function render() {
      content.replaceChildren();
      toc.replaceChildren();
      const headings = [];
      sections.forEach((section, sectionIndex) => {
        const article = document.createElement("article");
        article.className = "manual-section";
        article.innerHTML = safeMarkdown(section.body_md, markedApi, purifier);
        article.querySelectorAll("a[href]").forEach(a => { a.rel = "noopener noreferrer"; });
        article.querySelectorAll("h2,h3").forEach((heading, headingIndex) => {
          heading.id = `manual-${sectionIndex}-${headingIndex}`;
          headings.push({ id: heading.id, text: heading.textContent, level: heading.tagName });
        });
        content.appendChild(article);
      });
      headings.forEach(heading => {
        const a = document.createElement("a");
        a.href = `#${heading.id}`;
        a.textContent = heading.text;
        if (heading.level === "H3") a.className = "sub";
        a.onclick = event => { event.preventDefault(); document.getElementById(heading.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
        toc.appendChild(a);
      });
      status.textContent = sections.length ? "" : "ไม่พบเนื้อหาคู่มือสำหรับบัญชีนี้";
    }

    async function refresh() {
      const version = ++requestVersion;
      sections = [];
      content.replaceChildren();
      toc.replaceChildren();
      status.textContent = "กำลังโหลดคู่มือ";
      fallback.hidden = true;
      const { data, error } = await sb.rpc("get_manual", { p_lang: lang() });
      if (version !== requestVersion) return;
      if (error) { status.textContent = "โหลดคู่มือไม่สำเร็จ ลองใหม่"; return; }
      sections = data || [];
      fallback.hidden = !sections.some(row => row.fallback);
      render();
    }

    async function open() {
      if (menuPop) menuPop.hidden = true;
      if (!sections.length) await refresh();
      if (!dialog.open) dialog.showModal();
    }

    openButtons.forEach(button => button.addEventListener("click", open));
    return { clear, refresh, open };
  }

  root.SWEEO_MANUAL = { safeMarkdown, createController };
})(window);
