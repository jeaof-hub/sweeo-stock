"""Prepare private, checked SQL from the current Google Sheet export and Claude's ZIP.

Run with the bundled Python (openpyxl required). Output belongs in an ignored,
private directory; never commit the generated SQL or the source workbook.
"""

import argparse
import csv
import json
import re
import zipfile
from collections import Counter
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import openpyxl


ITEM_PATH = "supabase-data-DO-NOT-UPLOAD/02_seed_items.sql"
MOVEMENT_PATH = "supabase-data-DO-NOT-UPLOAD/03_seed_movements.sql"


def parse_row(line):
    if not line.startswith("("):
        raise ValueError("Expected a SQL value row")
    values = []
    i = 1
    while i < len(line):
        if line[i] == "'":
            i += 1
            chars = []
            while True:
                if i >= len(line):
                    raise ValueError("Unterminated SQL string")
                if line[i] == "'":
                    if i + 1 < len(line) and line[i + 1] == "'":
                        chars.append("'")
                        i += 2
                    else:
                        i += 1
                        break
                else:
                    chars.append(line[i])
                    i += 1
            value = "".join(chars)
        else:
            start = i
            while i < len(line) and line[i] not in ",)":
                i += 1
            raw = line[start:i].strip()
            value = None if raw.lower() == "null" else Decimal(raw)
        values.append(value)
        if i >= len(line):
            raise ValueError("Unterminated SQL value row")
        if line[i] == ")":
            break
        i += 1
    return values


def sql_value(value):
    if value is None:
        return "null"
    if isinstance(value, Decimal):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def sql_rows(text):
    return [parse_row(line) for line in text.splitlines() if line.startswith("(")]


def clean(value):
    text = "" if value is None else str(value).strip()
    return "" if text in {"-", "–", "—"} else text


def number(value, default=None):
    text = clean(value)
    return default if text == "" else Decimal(text)


def source_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        text = value.strip().strip('"').strip()
        if not text:
            return None
        try:
            return datetime.strptime(text, "%d-%b-%Y").date()
        except ValueError:
            pass
        try:
            return date.fromisoformat(text)
        except ValueError:
            pass
    if value is None or str(value).strip() == "":
        return None
    raise ValueError("Unrecognized source date; inspect the Google Sheet export")


def sheet_rows(sheet, width):
    return {
        row_number: [cell.value for cell in cells]
        for row_number, cells in enumerate(sheet.iter_rows(min_row=3, max_col=width), 3)
    }


def write_csv(path, columns, rows):
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(columns)
        for row in rows:
            writer.writerow(["" if value is None else str(value) for value in row])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xlsx", type=Path, required=True)
    parser.add_argument("--zip", dest="zip_path", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("migration/private"))
    args = parser.parse_args()

    with zipfile.ZipFile(args.zip_path) as archive:
        item_text = archive.read(ITEM_PATH).decode("utf-8")
        movement_text = archive.read(MOVEMENT_PATH).decode("utf-8")
    items, movements = sql_rows(item_text), sql_rows(movement_text)
    workbook = openpyxl.load_workbook(args.xlsx, read_only=True, data_only=True)
    stock = sheet_rows(workbook["SWEEOstock"], 18)
    goods = sheet_rows(workbook["2026 - GoodsDelivery"], 10)

    stock_product_rows = {n for n, r in stock.items() if any(clean(r[c]) for c in (3, 4, 5))}
    seed_item_rows = {int(r[0][1:]) for r in items}
    if stock_product_rows != seed_item_rows:
        raise ValueError("Stock product rows changed since the ZIP; remap item IDs before importing")
    item_ids = {r[0] for r in items}
    for record in items:
        row_number = int(record[0][1:])
        row = stock[row_number]
        for seed_index, sheet_index in ((1, 3), (2, 4), (3, 5), (4, 1), (5, 2), (6, 10), (7, 11)):
            if clean(record[seed_index]) != clean(row[sheet_index]):
                raise ValueError(f"Item row {row_number} changed since the ZIP")
        for seed_index, sheet_index, blank_default in ((8, 6, Decimal(0)), (9, 15, None), (10, 16, None)):
            if record[seed_index] != number(row[sheet_index], blank_default):
                raise ValueError(f"Item row {row_number} quantity/threshold changed since the ZIP")

    source_movement_rows = {
        n for n, r in goods.items()
        if (number(r[8], Decimal(0)) or 0) > 0 or (number(r[9], Decimal(0)) or 0) > 0
    }
    seed_movement_rows = {int(r[11][1:]) for r in movements}
    if source_movement_rows != seed_movement_rows:
        raise ValueError("Delivery rows changed since the ZIP; rebuild the migration mapping")

    movements_by_item = Counter()
    date_sources = Counter()
    invalid_date_rows = []
    recovered_document_rows = []
    revised = []
    for record in movements:
        row_number = int(record[11][1:])
        row = goods[row_number]
        if record[0] is not None and record[0] not in item_ids:
            raise ValueError(f"Delivery row {row_number} references a missing item")
        for seed_index, sheet_index in ((1, 7), (2, 6), (6, 4), (7, 3), (8, 5), (9, 2)):
            if clean(record[seed_index]) != clean(row[sheet_index]):
                raise ValueError(f"Delivery row {row_number} changed since the ZIP")
        out_qty, in_qty = number(row[8], Decimal(0)), number(row[9], Decimal(0))
        if (out_qty > 0) == (in_qty > 0):
            raise ValueError(f"Delivery row {row_number} has ambiguous in/out quantity")
        kind, qty = ("out", out_qty) if out_qty > 0 else ("in", in_qty)
        if record[4] != kind or record[5] != qty:
            raise ValueError(f"Delivery row {row_number} quantity changed since the ZIP")
        movements_by_item[record[0]] += qty if kind == "in" else -qty

        if not clean(row[3]) and isinstance(row[0], str) and re.fullmatch(r"IV\d{4}/\d+", row[0].strip(), re.I):
            record[7] = row[0].strip()
            recovered_document_rows.append(row_number)

        parsed_dates = []
        for raw_date in row[:2]:
            try:
                parsed_dates.append(source_date(raw_date))
            except ValueError:
                invalid_date_rows.append(row_number)
                parsed_dates.append(None)
        invoice_date, sent_date = parsed_dates
        if sent_date is not None:
            record[3] = sent_date.isoformat()
            date_sources["sent_date"] += 1
        elif invoice_date is not None:
            record[3] = invoice_date.isoformat()
            date_sources["invoice_date"] += 1
        else:
            record[3] = None
            date_sources["blank_in_sheet"] += 1
        revised.append(record)

    for record in items:
        row_number = int(record[0][1:])
        sheet_balance = number(stock[row_number][9])
        if sheet_balance is None or record[8] + movements_by_item[record[0]] != sheet_balance:
            raise ValueError(f"Balance mismatch at stock row {row_number}")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "02_seed_items.sql").write_text(item_text, encoding="utf-8")
    write_csv(
        args.out / "02_seed_items.csv",
        ["id", "code", "model", "spec", "type", "dept", "loc", "remark", "opening", "avg_month", "rop", "sort_order", "source"],
        items,
    )
    heading = (
        "-- SWEEO Stock: checked against the latest Google Sheet export.\n"
        "-- Blank dates in the source remain SQL NULL. Never commit this file.\n"
        "-- Run after 02_seed_items.sql and the updated 01_schema.sql.\n"
        "begin;\n"
        "insert into public.movements (item_id,code,model,date,kind,qty,customer,doc_no,dept,sale,source,legacy_id,created_by) values\n"
    )
    rows_sql = ",\n".join("(" + ",".join(sql_value(v) for v in row) + ")" for row in revised)
    (args.out / "03_seed_movements.sql").write_text(
        heading + rows_sql + "\non conflict (legacy_id) do nothing;\ncommit;\n", encoding="utf-8"
    )
    write_csv(
        args.out / "03_seed_movements.csv",
        ["item_id", "code", "model", "date", "kind", "qty", "customer", "doc_no", "dept", "sale", "source", "legacy_id"],
        [row[:-1] for row in revised],
    )
    summary = {
        "item_count": len(items),
        "movement_count": len(revised),
        "date_sources": dict(date_sources),
        "balances_matching_sheet": len(items),
        "movements_without_matching_item": sum(row[0] is None for row in revised),
        "rows_with_unrecognized_date_text": sorted(set(invalid_date_rows)),
        "document_number_recovered_from_date_column": recovered_document_rows,
    }
    (args.out / "audit.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
