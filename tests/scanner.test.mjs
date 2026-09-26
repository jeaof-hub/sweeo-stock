import test from "node:test";
import assert from "node:assert/strict";
import scanner from "../scanner.js";

const products = [
  { id: "elg", code: "1196G30301T", model: "ELG-150-36A", dept: "Project" },
  { id: "lamp", code: "5991301173T", model: "LFM-T8N181228-GFM", dept: "Retail" },
  { id: "other", code: "ABC-X9", model: "SPECIAL-UNIT", dept: "Other" }
];

const realLabelProducts = [
  { id: "r046", code: "5991301242T", model: "LSA-T8C090628-G", dept: "Retail" },
  { id: "r047", code: "5991301252T", model: "LSA-T8C090628-GS", dept: "Retail" },
  { id: "r176", code: "5991600048T", model: "LHC-TTG01-100-65", dept: "Retail" },
  { id: "r177", code: "5991600050T", model: "LHC-TTG01-200-40", dept: "Retail" },
  { id: "r178", code: "5991600051T", model: "LHC-TTG01-200-65", dept: "Retail" }
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

test("extracts the carton quantity as a hint without using it as a product code", () => {
  const result = scanner.matchProducts("ELG-150-36A Q'TY: 30 PCS LOT 2605060001", products);
  assert.equal(result.match?.id, "elg");
  assert.equal(result.cartonQty, 30);
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

test("exact code and model from the real LSA label select r046 over its sibling", () => {
  const result = scanner.matchProducts("SWEEO LSA-T8C090628-G LED T8 30PCS 2605060001 5991301242T", realLabelProducts);
  assert.equal(result.match?.id, "r046");
  assert.equal(result.candidates[0].product.id, "r046");
});

test("exact code and model from the real LHC label select r178", () => {
  const result = scanner.matchProducts("NLHC-TTG01-200-65 P200W Q'TY 3 PCS LOT 21114-2209270001 5991600051T", realLabelProducts);
  assert.equal(result.match?.id, "r178");
  assert.equal(result.candidates[0].product.id, "r178");
});

test("two incomplete fuzzy values rank r046 first but require operator confirmation", () => {
  const result = scanner.matchProducts("9991301242T LSA-T8C090628-", realLabelProducts);
  assert.equal(result.match, null);
  assert.equal(result.candidates[0].product.id, "r046");
  assert.ok(result.candidates[0].score < 1);
});

test("a numeric lot and carton quantity produce no real-label candidates", () => {
  const result = scanner.matchProducts("LOT 2605060001 Q'TY 30 PCS", realLabelProducts);
  assert.equal(result.match, null);
  assert.deepEqual(result.candidates, []);
});
