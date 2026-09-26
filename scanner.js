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

  function tokenData(text) {
    const raw = String(text || "").toUpperCase();
    const fuzzy = [], exact = [], individual = [];
    for (const line of raw.split(/[\r\n]+/)) {
      const parts = line.split(/[^A-Z0-9-]+/).map(compact).filter(Boolean);
      individual.push(...parts);
      fuzzy.push(...parts.filter(t => t.length >= 4 && /[A-Z]/.test(t)));
      for (let start = 0; start < parts.length; start++) {
        let joined = "";
        for (let end = start; end < Math.min(parts.length, start + 8); end++) {
          joined += parts[end];
          if (joined.length >= 3) exact.push(joined);
        }
      }
    }
    return { fuzzy: [...new Set(fuzzy)], exact: [...new Set(exact)], individual: [...new Set(individual)] };
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
    const tokenSet = tokenData(text), tokens = tokenSet.fuzzy, exactTokens = tokenSet.exact;
    const ranked = (products || []).filter(p => p && p.id && (compact(p.code) || compact(p.model))).map(product => {
      const codeScore = bestSimilarity(product.code, tokens);
      const modelScore = bestSimilarity(product.model, tokens);
      const code = compact(product.code), model = compact(product.model);
      // Codes may be joined to a preceding OCR label, but a suffix is never
      // accepted. Models must occupy the whole token so sibling model names
      // cannot both become exact (for example, ...-G and ...-GS).
      const exactCode = !!code && /[A-Z]/.test(code) && tokenSet.individual.some(t => t === code || (t.length > code.length && t.endsWith(code) && /[A-Z]/.test(t.slice(0, -code.length))));
      const exactModel = !!model && exactTokens.some(t => t === model);
      const exactTier = Number(exactCode) + Number(exactModel);
      let score = Math.max(codeScore, modelScore);
      if (codeScore >= 0.72 && modelScore >= 0.72) score = Math.min(1, score + 0.08);
      if (preferredDept(product.dept)) score = Math.min(1, score + 0.015);
      if (!exactTier) score = Math.min(0.989, score);
      return { product, score, codeScore, modelScore, exactCode, exactModel, exactTier, modelLength: model.length };
    }).filter(x => x.exactTier > 0 || x.score >= 0.68);

    const exactCodeCounts = new Map();
    for (const row of ranked) if (row.exactCode) {
      const code = compact(row.product.code);
      exactCodeCounts.set(code, (exactCodeCounts.get(code) || 0) + 1);
    }
    for (const row of ranked) {
      row.uniqueExactCode = row.exactCode && exactCodeCounts.get(compact(row.product.code)) === 1;
      row.exactRank = row.uniqueExactCode ? 4 : row.exactCode && row.exactModel ? 3 : row.exactCode ? 2 : row.exactModel ? 1 : 0;
    }
    ranked.sort((a, b) => b.exactRank - a.exactRank || (b.exactModel && a.exactModel ? b.modelLength - a.modelLength : 0) || b.score - a.score || Number(preferredDept(b.product.dept)) - Number(preferredDept(a.product.dept)) || String(a.product.id).localeCompare(String(b.product.id)));

    const top = ranked[0], second = ranked[1];
    const uniqueCodeMatches = ranked.filter(x => x.uniqueExactCode);
    const uniqueCodeWinner = uniqueCodeMatches.length === 1 ? uniqueCodeMatches[0] : null;
    const exactModels = ranked.filter(x => x.exactModel).sort((a, b) => b.modelLength - a.modelLength || b.score - a.score);
    const longestModelWinner = exactModels[0] && (!exactModels[1] || exactModels[0].modelLength > exactModels[1].modelLength) ? exactModels[0] : null;
    const exactWinner = uniqueCodeWinner || longestModelWinner;
    const strongFuzzyPair = top && !top.exactCode && !top.exactModel && top.codeScore >= 0.90 && top.modelScore >= 0.93 && (!second || top.score - second.score >= 0.08);
    const clearProduct = exactWinner?.product || (strongFuzzyPair ? top.product : null);
    return { match: clearProduct, candidates: ranked.slice(0, 3), tokens, cartonQty: extractCartonQuantity(text) };
  }

  return { compact, editDistance, extractCartonQuantity, matchProducts };
});
