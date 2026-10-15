type Row = Record<string, unknown>;

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
    const keys = Object.keys(rows[0] ?? {});
    const cells = [
      keys,
      ...rows.map((row) => keys.map((key) => display(row[key]))),
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
