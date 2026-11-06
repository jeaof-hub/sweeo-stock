/* Pure helpers for the price list tab. Database RLS (founder/owner only) is the source of visibility. */
(function (root) {
  "use strict";
  const allowedRoles = new Set(["founder", "owner"]);
  function canSeePrices(role) { return allowedRoles.has(role); }
  function money(value) {
    if (value === null || value === undefined || value === "") return "-";
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-";
  }
  function packLabel(row) {
    const a = row.pack_triplep || "", b = row.pack_project || "";
    if (!a || !b || a.replace(/\s/g, "") === b.replace(/\s/g, "")) return a || b || "-";
    return `TP ${a} / PJ ${b}`;
  }
  function categories(rows) {
    const seen = [];
    for (const row of rows) if (row.category && !seen.includes(row.category)) seen.push(row.category);
    return seen;
  }
  function filterPrices(rows, { query = "", category = "" } = {}) {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(row => row.active !== false && (!category || row.category === category) &&
      words.every(word => [row.commercial_name, row.project_name, row.watt, row.category]
        .some(value => String(value || "").toLowerCase().includes(word))))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }
  root.SWEEO_PRICE_LIST = { canSeePrices, money, packLabel, categories, filterPrices };
})(typeof window === "undefined" ? globalThis : window);
