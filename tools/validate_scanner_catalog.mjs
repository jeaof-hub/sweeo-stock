import fs from "node:fs";
import scanner from "../scanner.js";

const file = process.argv[2];
if (!file) throw new Error("usage: node tools/validate_scanner_catalog.mjs public-stock.json");
const products = JSON.parse(fs.readFileSync(file, "utf8")).map(row => ({
  id: String(row.id), code: row.code || "", model: row.model || "", dept: row.dept || ""
}));
if (!products.length) throw new Error("catalog is empty");

const counts = (field) => {
  const map = new Map();
  for (const product of products) {
    const value = scanner.compact(product[field]);
    if (value) map.set(value, (map.get(value) || 0) + 1);
  }
  return map;
};
const codeCounts = counts("code"), modelCounts = counts("model");
const failures = [];
let deterministic = 0, ambiguous = 0;

for (const product of products) {
  const code = scanner.compact(product.code), model = scanner.compact(product.model);
  if (!code && !model) { ambiguous++; continue; }
  const codeUnique = !!code && codeCounts.get(code) === 1;
  const modelUnique = !!model && modelCounts.get(model) === 1;
  const text = [product.model, product.code].filter(Boolean).join(" ");
  const result = scanner.matchProducts(text, products);
  if (!codeUnique && !modelUnique) {
    ambiguous++;
    const selected = result.match;
    if (selected && scanner.compact(selected.code) !== code && scanner.compact(selected.model) !== model) failures.push({ id: product.id, test: "ambiguous identity", got: selected.id });
    continue;
  }
  deterministic++;
  if (result.match?.id !== product.id) failures.push({ id: product.id, test: "model+code", got: result.match?.id || null, top: result.candidates[0]?.product.id || null });

  if (modelUnique) {
    const modelResult = scanner.matchProducts(product.model, products);
    if (modelResult.candidates[0]?.product.id !== product.id) failures.push({ id: product.id, test: "model-only rank", got: modelResult.match?.id || null, top: modelResult.candidates[0]?.product.id || null });
  }
}

const lot = scanner.matchProducts("LOT 2605060001 Q'TY 30 PCS", products);
if (lot.match || lot.candidates.length) failures.push({ test: "numeric lot", got: lot.match?.id || null, top: lot.candidates[0]?.product.id || null });

if (failures.length) {
  console.error(JSON.stringify({ catalog: products.length, deterministic, ambiguous, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ catalog: products.length, deterministic, ambiguous, failures: 0 }));
