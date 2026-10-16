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
        id: " shared-plan ",
        region_id: " example-b ",
        gpu_name: " Example GPU ",
      }),
    ).toEqual({
      id: "shared-plan",
      region_id: "example-b",
      gpu_name: "Example GPU",
    });
    expect(
      validateMachineQuery({ type: "gpu", available_only: false }),
    ).toEqual({
      type: "gpu",
      available_only: false,
    });
  });

  test("accepts positive safe integer requirement minimums", () => {
    const query = {
      min_vcpu: 4,
      min_memory_gb: 8,
      min_gpu_memory_gb: Number.MAX_SAFE_INTEGER,
    };
    expect(validateMachineQuery(query)).toEqual(query);
  });

  test.each(["min_vcpu", "min_memory_gb", "min_gpu_memory_gb"] as const)(
    "rejects invalid %s minimums",
    (field) => {
      for (const value of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        "4",
      ]) {
        expect(() => validateMachineQuery({ [field]: value })).toThrow(
          expect.objectContaining({ code: "invalid_input" }),
        );
      }
    },
  );

  test.each([
    { id: "" },
    { id: " " },
    { id: 123 },
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
    { type: "shared_cpu", min_gpu_memory_gb: 1 },
  ])("rejects invalid or contradictory filters %j", (query) => {
    expect(() => validateMachineQuery(query as MachineQuery)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});

describe("machine filtering", () => {
  const requirement_machine: MachineOffer = {
    provider_id: "example",
    id: "matching-offer",
    type: "gpu",
    source: "offer",
    availability: "available",
    region_ids: [],
    vcpu_count: 4,
    memory_mb: 8192,
    gpu_memory_gb: 24,
    currency: "USD",
  };

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

  test("matches an exact machine ID before applying the result limit", () => {
    expect(
      filterMachines(machines, { id: "gpu-offer", limit: 1 }).map(
        (machine) => machine.id,
      ),
    ).toEqual(["gpu-offer"]);
    expect(filterMachines(machines, { id: "gpu", limit: 1 })).toEqual([]);
    expect(
      filterMachines(machines, {
        id: "gpu-offer",
        type: "shared_cpu",
      }),
    ).toEqual([]);
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

  test("combines minimum requirements inclusively before limiting results", () => {
    const catalog: MachineOffer[] = [
      { ...requirement_machine, id: "fewer-cpus", vcpu_count: 3.5 },
      { ...requirement_machine, id: "less-ram", memory_mb: 8191 },
      { ...requirement_machine, id: "less-gpu-ram", gpu_memory_gb: 23.99 },
      requirement_machine,
      { ...requirement_machine, id: "larger-offer", vcpu_count: 8 },
    ];
    expect(
      filterMachines(catalog, {
        min_vcpu: 4,
        min_memory_gb: 8,
        min_gpu_memory_gb: 24,
        limit: 1,
      }).map((machine) => machine.id),
    ).toEqual(["matching-offer"]);
  });

  test.each([
    ["vcpu_count", "min_vcpu", 4],
    ["memory_mb", "min_memory_gb", 8],
    ["gpu_memory_gb", "min_gpu_memory_gb", 24],
  ] as const)(
    "excludes unknown or invalid %s when filtering %s",
    (field, filter, value) => {
      for (const specification of [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        const machine = { ...requirement_machine };
        if (specification === undefined) delete machine[field];
        else machine[field] = specification;
        expect(filterMachines([machine], { [filter]: value })).toEqual([]);
      }
    },
  );
});
