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
