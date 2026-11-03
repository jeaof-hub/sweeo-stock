import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("account menu is not clipped by a short page and remains scrollable", () => {
  assert.match(css, /body\{[^}]*overflow-x:clip/);
  assert.match(css, /\.wrap\{[^}]*overflow:visible/);
  assert.match(css, /\.menu \.pop\{[^}]*max-height:calc\(100dvh/);
  assert.match(css, /\.menu \.pop\{[^}]*overflow-y:auto/);
  assert.match(app, /window\.innerHeight - button\.getBoundingClientRect\(\)\.bottom - 8/);
  assert.match(app, /window\.addEventListener\("resize", fitMenuPop\)/);
});
