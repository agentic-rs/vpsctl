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
