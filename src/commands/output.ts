type Row = Record<string, unknown>;

function formatMoney(amount: number, currency?: string): string {
  const code = currency?.trim().toUpperCase();
  if (code === "USD") return `$ ${amount}`;
  if (code === "CNY") return `¥ ${amount}`;
  return code ? `${amount} ${code}` : String(amount);
}

const price_fields = new Set(["monthly_cost", "hourly_cost"]);

function displayCell(row: Row, key: string): string {
  const value = row[key];
  return display(
    price_fields.has(key) && typeof value === "number"
      ? formatMoney(
          value,
          typeof row.currency === "string" ? row.currency : undefined,
        )
      : value,
  );
}

function display(value: unknown): string {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal control characters from provider-supplied labels.
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function render(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "No results.";
    const rows = value as Row[];
    const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const has_prices = fields.some((key) => price_fields.has(key));
    const keys = fields.filter((key) => key !== "currency" || !has_prices);
    const cells = [
      keys,
      ...rows.map((row) => keys.map((key) => displayCell(row, key))),
    ];
    const widths = keys.map((_, index) =>
      Math.min(60, Math.max(...cells.map((row) => row[index]?.length ?? 0))),
    );
    return cells
      .map((row) =>
        row
          .map((cell, index) =>
            cell.slice(0, widths[index]).padEnd(widths[index] ?? 0),
          )
          .join("  ")
          .trimEnd(),
      )
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${display(entry)}`)
      .join("\n");
  }
  return display(value);
}
