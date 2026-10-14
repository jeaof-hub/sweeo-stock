const compact = (value: unknown) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const preferredDept = (value: unknown) => /^(RETAIL|PROJECT)$/i.test(String(value || "").trim());
const confusable = new Set(["0O", "O0", "1I", "I1", "1L", "L1", "5S", "S5", "8B", "B8", "2Z", "Z2", "6G", "G6"]);

function editDistance(left: string, right: string) {
  const a = compact(left), b = compact(right);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const next = [row];
    for (let column = 1; column <= b.length; column++) {
      const cost = a[row - 1] === b[column - 1] ? 0 : confusable.has(a[row - 1] + b[column - 1]) ? 0.2 : 1;
      next[column] = Math.min(next[column - 1] + 1, previous[column] + 1, previous[column - 1] + cost);
    }
    previous = next;
  }
  return previous[b.length];
}

function tokenData(text: string) {
  const fuzzy: string[] = [], exact: string[] = [], individual: string[] = [];
  for (const line of String(text || "").toUpperCase().split(/[\r\n]+/)) {
    const parts = line.split(/[^A-Z0-9-]+/).map(compact).filter(Boolean);
    individual.push(...parts);
    fuzzy.push(...parts.filter(token => token.length >= 4 && /[A-Z]/.test(token)));
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

function bestSimilarity(target: unknown, tokens: string[]) {
  const wanted = compact(target);
  if (!wanted) return 0;
  let best = 0;
  for (const token of tokens) {
    if (token === wanted || (wanted.length >= 7 && token.includes(wanted))) return 1;
    const lengths = [wanted.length - 1, wanted.length, wanted.length + 1].filter(length => length >= 4 && length <= token.length);
    const samples = token.length <= wanted.length + 1 ? [token] : lengths.flatMap(length => Array.from({ length: token.length - length + 1 }, (_, index) => token.slice(index, index + length)));
    for (const sample of samples) best = Math.max(best, 1 - editDistance(wanted, sample) / Math.max(wanted.length, sample.length));
  }
  return best;
}

export type LineProduct = { id: string; code?: string; model?: string; dept?: string; balance?: number; spec?: string };

export function matchLineProducts(text: string, products: LineProduct[]) {
  const tokenSet = tokenData(text), tokens = tokenSet.fuzzy, exactTokens = tokenSet.exact;
  const ranked = (products || []).filter(product => product?.id && (compact(product.code) || compact(product.model))).map(product => {
    const codeScore = bestSimilarity(product.code, tokens), modelScore = bestSimilarity(product.model, tokens);
    const code = compact(product.code), model = compact(product.model);
    const exactCode = !!code && /[A-Z]/.test(code) && tokenSet.individual.some(token => token === code || (token.length > code.length && token.endsWith(code) && /[A-Z]/.test(token.slice(0, -code.length))));
    const exactModel = !!model && exactTokens.some(token => token === model);
    const exactTier = Number(exactCode) + Number(exactModel);
    let score = Math.max(codeScore, modelScore);
    if (codeScore >= 0.72 && modelScore >= 0.72) score = Math.min(1, score + 0.08);
    if (preferredDept(product.dept)) score = Math.min(1, score + 0.015);
    if (!exactTier) score = Math.min(0.989, score);
    return { product, score, codeScore, modelScore, exactCode, exactModel, exactTier, modelLength: model.length, uniqueExactCode: false, exactRank: 0 };
  }).filter(row => row.exactTier > 0 || row.score >= 0.68);
  const codeCounts = new Map<string, number>();
  for (const row of ranked) if (row.exactCode) codeCounts.set(compact(row.product.code), (codeCounts.get(compact(row.product.code)) || 0) + 1);
  for (const row of ranked) {
    row.uniqueExactCode = row.exactCode && codeCounts.get(compact(row.product.code)) === 1;
    row.exactRank = row.uniqueExactCode ? 4 : row.exactCode && row.exactModel ? 3 : row.exactCode ? 2 : row.exactModel ? 1 : 0;
  }
  ranked.sort((a, b) => b.exactRank - a.exactRank || (b.exactModel && a.exactModel ? b.modelLength - a.modelLength : 0) || b.score - a.score || Number(preferredDept(b.product.dept)) - Number(preferredDept(a.product.dept)) || a.product.id.localeCompare(b.product.id));
  const uniqueCodes = ranked.filter(row => row.uniqueExactCode);
  const exactModels = ranked.filter(row => row.exactModel).sort((a, b) => b.modelLength - a.modelLength || b.score - a.score);
  const exactWinner = uniqueCodes.length === 1 ? uniqueCodes[0] : exactModels[0] && (!exactModels[1] || exactModels[0].modelLength > exactModels[1].modelLength) ? exactModels[0] : null;
  return { match: exactWinner?.product || null, candidates: ranked.slice(0, 13) };
}

export { compact, editDistance };
