import { describe, expect, test } from "bun:test";
import { filterMachines, validateMachineQuery } from "../src/core/machines.ts";
import type { MachineOffer, MachineQuery } from "../src/core/provider.ts";

const machines: MachineOffer[] = [
  {
    provider_id: "example",
    id: "shared-plan",
    type: "shared_cpu",
    source: "plan",
    availability: "unknown",
    region_ids: ["example-a", "example-b"],
    vcpu_count: 2,
    disk_gb: 40,
    monthly_cost: 6,
    currency: "USD",
  },
  {
    provider_id: "example",
    id: "dedicated-plan",
    type: "dedicated_cpu",
    source: "plan",
    availability: "unavailable",
    region_ids: ["example-b"],
    disk_gb: 80,
    currency: "USD",
  },
  {
    provider_id: "example",
    id: "metal-plan",
    type: "bare_metal",
    source: "plan",
    availability: "available",
    region_ids: ["example-b"],
    cpu_count: 8,
    disk_gb: 160,
    currency: "USD",
  },
  {
    provider_id: "example",
    id: "gpu-offer",
    type: "gpu",
    source: "offer",
    availability: "available",
    region_ids: [],
    gpu_name: "Example GPU",
    gpu_count: 2,
    hourly_cost: 0.75,
    currency: "USD",
  },
];

describe("machine query validation", () => {
  test("normalizes strings and drops undefined fields", () => {
    expect(validateMachineQuery()).toEqual({});
    expect(
      validateMachineQuery({
        region_id: " example-b ",
        gpu_name: " Example GPU ",
      }),
    ).toEqual({ region_id: "example-b", gpu_name: "Example GPU" });
    expect(
      validateMachineQuery({ type: "gpu", available_only: false }),
    ).toEqual({
      type: "gpu",
      available_only: false,
    });
  });

  test.each([
    { type: "unknown" },
    { type: "shared-cpu" },
    { region_id: " " },
    { gpu_name: "" },
    { gpu_count: 0 },
    { gpu_count: 1.5 },
    { gpu_count: Number.MAX_SAFE_INTEGER + 1 },
    { disk_gb: -1 },
    { disk_gb: Number.POSITIVE_INFINITY },
    { limit: 101 },
    { limit: 0 },
    { limit: 1.5 },
    { available_only: "true" },
    { unexpected: true },
    { type: "shared_cpu", gpu_name: "Example GPU" },
    { type: "bare_metal", gpu_count: 1 },
    { type: "dedicated_cpu", gpu_count: 2 },
  ])("rejects invalid or contradictory filters %j", (query) => {
    expect(() => validateMachineQuery(query as MachineQuery)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});

describe("machine filtering", () => {
  test("preserves catalog order, unknown stock, and all four categories by default", () => {
    expect(filterMachines(machines, {})).toEqual(machines);
    expect(
      filterMachines(Array.from({ length: 40 }, () => machines).flat(), {}),
    ).toHaveLength(160);
  });

  test("combines region, category, and capacity before applying a limit", () => {
    expect(
      filterMachines(machines, {
        region_id: "example-b",
        disk_gb: 80,
        limit: 1,
      }).map((machine) => machine.id),
    ).toEqual(["dedicated-plan"]);
    expect(
      filterMachines(machines, {
        type: "bare_metal",
        region_id: "example-b",
      }).map((machine) => machine.id),
    ).toEqual(["metal-plan"]);
  });

  test("available-only excludes unknown as well as sold-out capacity", () => {
    expect(
      filterMachines(machines, { available_only: true }).map(
        (machine) => machine.id,
      ),
    ).toEqual(["metal-plan", "gpu-offer"]);
  });

  test("does not invent disk sizes, region assignments, or GPU models", () => {
    expect(filterMachines(machines, { type: "gpu", disk_gb: 1 })).toEqual([]);
    expect(
      filterMachines(machines, { type: "gpu", region_id: "example-b" }),
    ).toEqual([]);
    expect(filterMachines(machines, { gpu_name: "Unknown GPU" })).toEqual([]);
    expect(filterMachines(machines, { gpu_count: 1 })).toEqual([]);
    expect(
      filterMachines(machines, { gpu_name: "Example GPU", gpu_count: 2 }).map(
        (machine) => machine.id,
      ),
    ).toEqual(["gpu-offer"]);
  });
});
