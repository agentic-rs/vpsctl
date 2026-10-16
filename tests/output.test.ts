import { expect, test } from "bun:test";
import { render } from "../src/commands/output.ts";

test("tables retain optional GPU and pricing fields from later rows", () => {
  const output = render([
    { id: "cpu-example", name: "CPU example" },
    { id: "gpu-example", name: "GPU example", gpu_count: 2, hourly_cost: 0.5 },
  ]);
  const [header, cpu_row, gpu_row] = output.split("\n");
  expect(header).toContain("gpu_count");
  expect(header).toContain("hourly_cost");
  expect(cpu_row).toBe("cpu-example  CPU example");
  expect(gpu_row).toContain("gpu-example");
  expect(gpu_row).toContain("2");
  expect(gpu_row).toContain("0.5");
  expect(output).not.toContain("undefined");
});

test("optional table values still strip terminal controls", () => {
  const output = render([
    { id: "example" },
    { id: "example-2", label: "safe\u001b[2J" },
  ]);
  expect(output).toContain("label");
  expect(output).toContain("safe [2J");
  expect(output).not.toContain("\u001b");
});

test("provider price tables embed currency without changing their numeric input", () => {
  const rows = [
    { id: "example-plan", monthly_cost: 6, currency: "USD" },
    { id: "example-offer", hourly_cost: 0.125, currency: "CNY" },
    { id: "another-plan", monthly_cost: 9.5, currency: "EUR" },
  ];
  const before = JSON.stringify(rows);
  const output = render(rows);
  expect(output.split("\n")[0]).not.toContain("currency");
  expect(output).toContain("$ 6");
  expect(output).toContain("¥ 0.125");
  expect(output).toContain("9.5 EUR");
  expect(JSON.stringify(rows)).toBe(before);
});

const inventory = [
  {
    id: "example-12345678-1234-5678-123456789012",
    label: "Example machine with a long label",
    status: "running",
    region_id: "example-region",
    plan_id: "example-plan",
    public_ipv4: "192.0.2.10",
    monthly_cost: 6,
    currency: "USD",
  },
  {
    id: "example-second-instance",
    label: "Second machine",
    status: "stopped",
    region_id: "example-region",
    plan_id: "example-plan",
    public_ipv4: "192.0.2.11",
    hourly_cost: 0.5,
    currency: "USD",
  },
];

test("narrow tables keep identity, status, and prices and name hidden fields", () => {
  const before = JSON.stringify(inventory);
  const output = render(inventory, { columns: 54 });
  const [header] = output.split("\n");
  expect(header).toContain("id");
  expect(header).toContain("status");
  expect(header).toContain("monthly_cost");
  expect(header).toContain("hourly_cost");
  expect(header).not.toContain("public_ipv4");
  expect(output).toContain("$ 6");
  expect(output).toContain("$ 0.5");
  expect(output).not.toContain("currency");
  const [table, notice = ""] = output.split("Hidden fields:");
  expect(table?.trimEnd().split("\n")).toHaveLength(3);
  for (const field of ["label", "region_id", "plan_id", "public_ipv4"]) {
    expect(notice).toContain(field);
  }
  expect(notice).toContain("--json");
  expect(JSON.stringify(inventory)).toBe(before);
  for (const line of output.split("\n")) {
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(54);
  }
});

test("wide tables retain the full field set and expand useful content", () => {
  const output = render(inventory, { columns: 200 });
  const [header] = output.split("\n");
  for (const field of [
    "id",
    "label",
    "status",
    "region_id",
    "plan_id",
    "public_ipv4",
    "monthly_cost",
    "hourly_cost",
  ]) {
    expect(header).toContain(field);
  }
  expect(output).toContain(inventory[0]?.id ?? "");
  expect(output).toContain("Example machine with a long label");
  expect(output).not.toContain("Hidden fields:");
  expect(output).not.toContain("…");
});

test("spare width expands account IDs before verbose credential fields", () => {
  const id = "example:account@example.invalid";
  const output = render(
    [
      {
        id,
        provider_id: "example",
        is_default: true,
        credentials: { api_key: { source: "literal", value: "[redacted]" } },
      },
    ],
    { columns: 80 },
  );
  expect(output).toContain(id);
  for (const line of output.split("\n")) {
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  }
});

test.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  "unknown or invalid terminal width %s keeps every column",
  (columns) => {
    const output = render(inventory, { columns });
    expect(output).toBe(render(inventory));
    expect(output).not.toContain("Hidden fields:");
    expect(output.split("\n")[0]).toContain("public_ipv4");
  },
);

test("uses terminal cell widths when aligning CJK, emoji, and combining marks", () => {
  const output = render(
    [
      { id: "界", name: "ready" },
      { id: "👩‍💻", name: "ready" },
      { id: "e\u0301", name: "ready" },
    ],
    { columns: 12 },
  );
  const lines = output.split("\n");
  expect(lines).toEqual([
    "id  name",
    "界  ready",
    "👩‍💻  ready",
    "e\u0301   ready",
  ]);
  for (const line of lines.slice(1)) {
    expect(Bun.stringWidth(line.slice(0, line.indexOf("ready")))).toBe(4);
  }
});

test("truncation preserves graphemes and never exceeds even a one-column terminal", () => {
  const rows = [
    { id: "界界界", ["界".repeat(8)]: "x" },
    { id: "👩‍💻👩‍💻👩‍💻" },
    { id: "e\u0301".repeat(20) },
    { id: "🇨🇳🇨🇳🇨🇳" },
  ];
  for (let columns = 1; columns <= 120; columns += 1) {
    const output = render(rows, { columns });
    for (const line of output.split("\n")) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
      expect(line).not.toContain("\ufffd");
    }
    const [, cjk = "", emoji = "", combining = "", flags = ""] =
      output.split("\n");
    expect(cjk.trimEnd().split(/ {2,}/)[0]).toMatch(/^(?:界)*(?:…)?$/u);
    expect(emoji.trimEnd().split(/ {2,}/)[0]).toMatch(/^(?:👩‍💻)*(?:…)?$/u);
    expect(combining.trimEnd().split(/ {2,}/)[0]).toMatch(
      /^(?:e\u0301)*(?:…)?$/u,
    );
    expect(flags.trimEnd().split(/ {2,}/)[0]).toMatch(/^(?:🇨🇳)*(?:…)?$/u);
  }
});

test("truncated long cells end in an ellipsis instead of silently dropping text", () => {
  const output = render([{ id: "x".repeat(100) }]);
  expect(output.split("\n")[1]).toBe(`${"x".repeat(59)}…`);
});

test("sanitizes field headings and reports hidden fields introduced by later rows", () => {
  const output = render(
    [
      { id: "example-a" },
      { id: "example-b", "unsafe\u001b\nheading": "hidden", gpu_count: 2 },
    ],
    { columns: 16 },
  );
  expect(output).not.toContain("\u001b");
  expect(output).not.toContain("undefined");
  expect(output).toContain("Hidden fields:");
  expect(output.replace(/\s+/g, "")).toContain("unsafeheading");
  expect(output.replace(/\s+/g, "")).toContain("gpu_count");
});

test("non-table output and empty results retain their current format", () => {
  expect(render({ status: "accepted" }, { columns: 5 })).toBe(
    "status: accepted",
  );
  expect(render([], { columns: 80 })).toBe("No results.");
  expect(render([{}], { columns: 80 })).toBe("No fields.");
});
