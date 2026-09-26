import test from "node:test";
import assert from "node:assert/strict";
import scanner from "../scanner.js";

const products = [
  { id: "elg", code: "1196G30301T", model: "ELG-150-36A", dept: "Project" },
  { id: "lamp", code: "5991301173T", model: "LFM-T8N181228-GFM", dept: "Retail" },
  { id: "other", code: "ABC-X9", model: "SPECIAL-UNIT", dept: "Other" }
];

test("matches a real non-599 product code exactly", () => {
  const result = scanner.matchProducts("ITEM 1196G30301T  LOT 2605060001", products);
  assert.equal(result.match?.id, "elg");
});

test("matches the standard code from the database without relying on its pattern", () => {
  assert.equal(scanner.matchProducts("5991301173T", products).match?.id, "lamp");
});

test("matches arbitrary real codes from the database", () => {
  assert.equal(scanner.matchProducts("PRODUCT ABC-X9", products).match?.id, "other");
});

test("tolerates a common one-character OCR error", () => {
  assert.equal(scanner.matchProducts("9991301173T LFM-T8N181228-GFI", products).match?.id, "lamp");
});

test("does not confuse a lot number or carton quantity with a product", () => {
  const result = scanner.matchProducts("LOT 2605060001 Q'TY 30 PCS", products);
  assert.equal(result.match, null);
  assert.equal(result.candidates.length, 0);
});

test("duplicate exact codes require the operator to choose", () => {
  const duplicated = [...products, { id: "dup", code: "1196G30301T", model: "ELG-SPARE", dept: "Retail" }];
  const result = scanner.matchProducts("1196G30301T", duplicated);
  assert.equal(result.match, null);
  assert.deepEqual(result.candidates.slice(0, 2).map(x => x.product.id).sort(), ["dup", "elg"]);
});

test("Retail and Project rank ahead when fuzzy scores are otherwise equal", () => {
  const result = scanner.matchProducts("CODE777X", [
    { id: "other", code: "CODE777Y", model: "", dept: "Other" },
    { id: "retail", code: "CODE777Z", model: "", dept: "Retail" }
  ]);
  assert.equal(result.candidates[0].product.id, "retail");
  assert.equal(result.match, null);
});
