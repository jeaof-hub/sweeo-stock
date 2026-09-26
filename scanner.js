/* Camera OCR and product matching for SWEEO Stock. Images stay in this browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SWEEO_SCANNER = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const compact = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const preferredDept = value => /^(RETAIL|PROJECT)$/i.test(String(value || "").trim());
  const confusable = new Set(["0O", "O0", "1I", "I1", "1L", "L1", "5S", "S5", "8B", "B8", "2Z", "Z2", "6G", "G6"]);

  function editDistance(a, b) {
    a = compact(a); b = compact(b);
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : confusable.has(a[i - 1] + b[j - 1]) ? 0.2 : 1;
        next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = next;
    }
    return prev[b.length];
  }

  function tokensFrom(text) {
    const tokens = String(text || "").toUpperCase().split(/[^A-Z0-9-]+/).map(compact).filter(t => t.length >= 4);
    const joined = compact(text);
    if (joined.length >= 4) tokens.push(joined);
    return [...new Set(tokens)];
  }

  function extractCartonQuantity(text) {
    const match = String(text || "").toUpperCase().match(/Q\s*['’]?\s*T\s*Y\s*[:=]?\s*(\d{1,4})\s*(?:PCS?)?/);
    const quantity = match ? Number(match[1]) : 0;
    return Number.isInteger(quantity) && quantity > 0 ? quantity : null;
  }

  function bestSimilarity(target, tokens) {
    const wanted = compact(target);
    if (!wanted) return 0;
    let best = 0;
    for (const token of tokens) {
      if (token === wanted || (wanted.length >= 7 && token.includes(wanted))) return 1;
      const lengths = [wanted.length - 1, wanted.length, wanted.length + 1].filter(n => n >= 4 && n <= token.length);
      const samples = token.length <= wanted.length + 1 ? [token] : lengths.flatMap(n => Array.from({ length: token.length - n + 1 }, (_, i) => token.slice(i, i + n)));
      for (const sample of samples) {
        const similarity = 1 - editDistance(wanted, sample) / Math.max(wanted.length, sample.length);
        if (similarity > best) best = similarity;
      }
    }
    return best;
  }

  function matchProducts(text, products) {
    const tokens = tokensFrom(text);
    const ranked = (products || []).filter(p => p && p.id && (compact(p.code) || compact(p.model))).map(product => {
      const codeScore = bestSimilarity(product.code, tokens);
      const modelScore = bestSimilarity(product.model, tokens);
      const code = compact(product.code), model = compact(product.model);
      const exactCode = !!code && tokens.some(t => t === code || (code.length >= 7 && t.includes(code)));
      const exactModel = !!model && tokens.some(t => t === model || (model.length >= 7 && t.includes(model)));
      let score = Math.max(codeScore, modelScore);
      if (codeScore >= 0.72 && modelScore >= 0.72) score = Math.min(1, score + 0.08);
      if (preferredDept(product.dept)) score = Math.min(1, score + 0.015);
      return { product, score, codeScore, modelScore, exactCode, exactModel };
    }).filter(x => x.score >= 0.68).sort((a, b) => b.score - a.score || Number(preferredDept(b.product.dept)) - Number(preferredDept(a.product.dept)) || String(a.product.id).localeCompare(String(b.product.id)));

    const top = ranked[0], second = ranked[1];
    const exactIdentity = top && (top.exactCode || top.exactModel);
    const sameExact = exactIdentity && ranked.filter(x => (top.exactCode && x.exactCode) || (top.exactModel && x.exactModel)).length > 1;
    const clear = !!top && !sameExact && ((exactIdentity && (!second || top.score - second.score >= 0.01)) || (top.score >= 0.88 && (!second || top.score - second.score >= 0.08)));
    return { match: clear ? top.product : null, candidates: ranked.slice(0, 3), tokens, cartonQty: extractCartonQuantity(text) };
  }

  return { compact, editDistance, extractCartonQuantity, matchProducts };
});
