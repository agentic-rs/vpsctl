type Row = Record<string, unknown>;

export interface RenderOptions {
  columns?: number | undefined;
}

interface TableColumn {
  index: number;
  key: string;
  preferred_width: number;
  minimum_width: number;
  priority: number;
}

const column_priorities: Readonly<Record<string, number>> = {
  id: 0,
  status: 1,
  type: 1,
  availability: 1,
  monthly_cost: 2,
  hourly_cost: 2,
  label: 3,
  name: 3,
  email: 3,
  gpu_name: 4,
  gpu_count: 4,
  vcpu_count: 5,
  cpu_count: 5,
  memory_mb: 5,
  gpu_memory_gb: 5,
  disk_gb: 5,
  region_id: 6,
  region_ids: 6,
  provider_id: 6,
  is_default: 6,
};

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

function terminalColumns(columns: number | undefined): number | undefined {
  return columns !== undefined && Number.isFinite(columns) && columns >= 1
    ? Math.floor(columns)
    : undefined;
}

function selectColumns(
  columns: TableColumn[],
  available: number | undefined,
): TableColumn[] {
  if (available === undefined) return columns;
  const selected: TableColumn[] = [];
  let remaining = available;
  for (const column of [...columns].sort(priorityOrder)) {
    const required = column.minimum_width + (selected.length > 0 ? 2 : 0);
    if (required <= remaining || selected.length === 0) {
      selected.push(column);
      remaining -= required;
    }
  }
  return selected.sort((left, right) => left.index - right.index);
}

function priorityOrder(left: TableColumn, right: TableColumn): number {
  return left.priority - right.priority || left.index - right.index;
}

function columnWidths(
  columns: TableColumn[],
  available: number | undefined,
): number[] {
  if (available === undefined) {
    return columns.map((column) => column.preferred_width);
  }
  const budget = available - Math.max(0, columns.length - 1) * 2;
  const widths = columns.map((column) =>
    Math.min(column.minimum_width, budget),
  );
  let remaining = budget - widths.reduce((sum, width) => sum + width, 0);
  for (const [index, column] of [...columns.entries()].sort(
    ([, left], [, right]) => priorityOrder(left, right),
  )) {
    const width = widths[index] ?? 0;
    const growth = Math.min(remaining, column.preferred_width - width);
    widths[index] = width + growth;
    remaining -= growth;
    if (remaining === 0) break;
  }
  return widths;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncate(value: string, width: number): string {
  if (Bun.stringWidth(value) <= width) return value;
  let text = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const size = Bun.stringWidth(segment);
    if (used + size > width - 1) break;
    text += segment;
    used += size;
  }
  return `${text}…`;
}

function fitCell(value: string, width: number): string {
  const cell = truncate(value, width);
  return cell + " ".repeat(Math.max(0, width - Bun.stringWidth(cell)));
}

function renderTable(rows: Row[], available: number | undefined): string {
  if (rows.length === 0) return "No results.";
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const has_prices = fields.some((key) => price_fields.has(key));
  const keys = fields.filter((key) => key !== "currency" || !has_prices);
  if (keys.length === 0) return "No fields.";
  const cells = [
    keys.map(display),
    ...rows.map((row) => keys.map((key) => displayCell(row, key))),
  ];
  const columns = keys.map((key, index): TableColumn => {
    let preferred_width = 1;
    for (const row of cells) {
      preferred_width = Math.max(
        preferred_width,
        Bun.stringWidth(row[index] ?? ""),
      );
    }
    preferred_width = Math.min(60, preferred_width);
    return {
      index,
      key,
      preferred_width,
      minimum_width: Math.min(
        preferred_width,
        Math.max(Bun.stringWidth(display(key)), key === "id" ? 16 : 8),
      ),
      priority: Object.hasOwn(column_priorities, key)
        ? (column_priorities[key] ?? 10)
        : 10,
    };
  });
  const selected = selectColumns(columns, available);
  const widths = columnWidths(selected, available);
  const lines = cells.map((row) =>
    selected
      .map((column, index) =>
        fitCell(row[column.index] ?? "", widths[index] ?? 1),
      )
      .join("  ")
      .trimEnd(),
  );
  const visible = new Set(selected.map((column) => column.key));
  const hidden = keys.filter((key) => !visible.has(key));
  if (hidden.length > 0 && available !== undefined) {
    lines.push(
      Bun.wrapAnsi(
        `Hidden fields: ${hidden.map(display).join(", ")}. Use --json for all fields.`,
        available,
        { hard: true },
      )
        .split("\n")
        .map((line) => truncate(line, available))
        .join("\n"),
    );
  }
  return lines.join("\n");
}

export function render(value: unknown, options: RenderOptions = {}): string {
  if (Array.isArray(value)) {
    return renderTable(value as Row[], terminalColumns(options.columns));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${display(entry)}`)
      .join("\n");
  }
  return display(value);
}
