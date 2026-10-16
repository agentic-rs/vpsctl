import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PromptOption,
  PromptSelectOptions,
  TextPromptOptions,
} from "../src/commands/context.ts";
import { type CliIO, runCli } from "../src/commands/program.ts";
import { AccountStore } from "../src/core/accounts.ts";
import { AppError } from "../src/core/errors.ts";
import { filterMachines } from "../src/core/machines.ts";
import type {
  CreateInstanceInput,
  MachineOffer,
  MachineQuery,
  Provider,
  ProviderDefinition,
} from "../src/core/provider.ts";
import { ProviderRegistry } from "../src/core/registry.ts";

type ProviderId = "vultr" | "runpod" | "vast";

interface FixtureOptions {
  pick_account?: boolean;
  missing_credential?: boolean;
}

interface RunOptions {
  interactive?: boolean;
  confirmation?: boolean;
  selections?: Record<string, string | string[]>;
  text?: Record<string, string | string[]>;
  cancel_prompt?: string;
  cancel_progress?: {
    message: string;
    timing: "before" | "during";
  };
}

const temp_dirs: string[] = [];

function machine(provider_id: ProviderId): MachineOffer {
  return {
    provider_id,
    id:
      provider_id === "vultr"
        ? "shared-small"
        : provider_id === "runpod"
          ? "gpu-example"
          : "321",
    name: "Example machine",
    type: provider_id === "vultr" ? "shared_cpu" : "gpu",
    source: provider_id === "vast" ? "offer" : "plan",
    availability: "available",
    region_ids: ["test-region"],
    vcpu_count: 2,
    memory_mb: 4096,
    disk_gb: 100,
    currency: "USD",
    ...(provider_id === "vultr"
      ? { monthly_cost: 6 }
      : { gpu_name: "Example GPU", gpu_count: 1, hourly_cost: 0.75 }),
  };
}

async function fixture(provider_id: ProviderId, options: FixtureOptions = {}) {
  const temp_dir = await mkdtemp(join(tmpdir(), "vpsctl-guided-create-"));
  temp_dirs.push(temp_dir);
  const config_path = join(temp_dir, "config.json");
  const store = new AccountStore(config_path);
  await store.add({
    id: `sample-${provider_id}`,
    provider_id,
    credentials: options.missing_credential
      ? { api_key: { source: "env", name: "UNSET_TEST_TOKEN" } }
      : { api_key: { source: "literal", value: "synthetic-api-key" } },
  });
  if (!options.pick_account) await store.use(`sample-${provider_id}`);

  const queries: MachineQuery[] = [];
  const creates: CreateInstanceInput[] = [];
  const reads: string[] = [];
  const trace: string[] = [];
  let connections = 0;
  let machines = [machine(provider_id)];
  let discovery_error: AppError | undefined;
  let raw_discovery = false;
  const definition = new ProviderRegistry().get(provider_id);
  const provider: Provider = {
    info: definition.info,
    async listMachines(query = {}) {
      reads.push("machines");
      trace.push("read:machines");
      queries.push({ ...query });
      if (discovery_error) throw discovery_error;
      const quoted = machines.map((entry) =>
        provider_id === "runpod"
          ? {
              ...entry,
              gpu_count: query.gpu_count ?? 1,
              ...(entry.hourly_cost === undefined
                ? {}
                : {
                    hourly_cost: entry.hourly_cost * (query.gpu_count ?? 1),
                  }),
            }
          : entry,
      );
      return raw_discovery ? quoted : filterMachines(quoted, query);
    },
    async listRegions() {
      reads.push("regions");
      trace.push("read:regions");
      return [{ id: "test-region", name: "Example region", country: "XX" }];
    },
    async listImages() {
      reads.push("images");
      trace.push("read:images");
      return [
        {
          id: "101",
          name: "Example Linux",
          architecture: "x64",
          family: "linux",
        },
      ];
    },
    async createInstance(input) {
      creates.push({ ...input });
      trace.push("create");
      return { provider_id, id: "created-example", status: "accepted" };
    },
    async listInstances() {
      throw new Error("Unexpected inventory request.");
    },
    async getInstance() {
      throw new Error("Unexpected instance request.");
    },
    async editInstance() {
      throw new Error("Unexpected edit.");
    },
    async destroyInstance() {
      throw new Error("Unexpected destruction.");
    },
    async startInstance() {
      throw new Error("Unexpected start.");
    },
    async stopInstance() {
      throw new Error("Unexpected stop.");
    },
    async rebootInstance() {
      throw new Error("Unexpected reboot.");
    },
    async listPlans() {
      throw new Error("Use the availability-aware machine catalog.");
    },
    async listSshKeys() {
      throw new Error("Unexpected SSH key request.");
    },
  };
  const mocked_definition: ProviderDefinition = {
    ...definition,
    create() {
      connections += 1;
      return provider;
    },
  };
  const registry = new ProviderRegistry([mocked_definition]);
  const run = async (args: string[] = [], options: RunOptions = {}) => {
    const selection_inputs = Object.fromEntries(
      Object.entries(options.selections ?? {}).map(([message, value]) => [
        message,
        Array.isArray(value) ? [...value] : value,
      ]),
    );
    const text_inputs = Object.fromEntries(
      Object.entries(options.text ?? {}).map(([message, value]) => [
        message,
        Array.isArray(value) ? [...value] : value,
      ]),
    );
    const nextInput = (
      inputs: Record<string, string | string[]>,
      message: string,
    ) => {
      const value = inputs[message];
      return Array.isArray(value) ? value.shift() : value;
    };
    const output: string[] = [];
    const errors: string[] = [];
    const notes: string[] = [];
    const note_titles: string[] = [];
    const events: string[] = [];
    const text_prompts: string[] = [];
    const text_prompt_options: {
      message: string;
      options?: TextPromptOptions;
    }[] = [];
    const selections: {
      message: string;
      options: PromptOption[];
      prompt_options?: PromptSelectOptions;
    }[] = [];
    const confirmations: string[] = [];
    const progress_events: string[] = [];
    const cancelled = (message: string) => {
      if (options.cancel_prompt === message) {
        throw new AppError("cancelled", "Operation cancelled.");
      }
    };
    const io: CliIO = {
      is_interactive: options.interactive ?? true,
      write_out(text) {
        output.push(text);
      },
      write_err(text) {
        errors.push(text);
        events.push(text);
      },
      async select(message, choices, prompt_options) {
        cancelled(message);
        trace.push(`select:${message}`);
        selections.push({
          message,
          options: choices,
          ...(prompt_options === undefined ? {} : { prompt_options }),
        });
        return nextInput(selection_inputs, message) ?? choices[0]?.value ?? "";
      },
      async read_text(message, prompt_options) {
        cancelled(message);
        trace.push(`text:${message}`);
        text_prompts.push(message);
        text_prompt_options.push({
          message,
          ...(prompt_options === undefined ? {} : { options: prompt_options }),
        });
        return (
          nextInput(text_inputs, message) ??
          prompt_options?.initial_value ??
          (message === "Docker image" ? "example/image:latest" : "")
        );
      },
      note(message, title) {
        notes.push(message);
        if (title) note_titles.push(title);
        events.push(message);
      },
      progress(message) {
        progress_events.push(`start:${message}`);
        const controller = new AbortController();
        if (options.cancel_progress?.message === message) {
          const cancel = () =>
            controller.abort(new AppError("cancelled", "Operation cancelled."));
          if (options.cancel_progress.timing === "before") cancel();
          else queueMicrotask(cancel);
        }
        return {
          signal: controller.signal,
          stop() {
            progress_events.push(`stop:${message}`);
          },
          fail() {
            progress_events.push(`fail:${message}`);
          },
        };
      },
      async confirm(message) {
        cancelled(message);
        trace.push(`confirm:${message}`);
        confirmations.push(message);
        events.push("confirmed");
        return options.confirmation ?? true;
      },
    };
    const exit_code = await runCli(
      ["--config", config_path, "instance", "create", ...args],
      { env: {}, io, registry },
    );
    return {
      exit_code,
      stdout: output.join(""),
      stderr: errors.join(""),
      review: [...notes, ...errors].join("\n"),
      note_titles,
      events,
      text_prompts,
      text_prompt_options,
      selections,
      confirmations,
      progress_events,
    };
  };
  return {
    config_path,
    run,
    creates,
    queries,
    reads,
    trace,
    get connections() {
      return connections;
    },
    setMachines(value: MachineOffer[], raw = false) {
      machines = value;
      raw_discovery = raw;
    },
    failDiscovery(error: AppError) {
      discovery_error = error;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temp_dirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("guided instance creation", () => {
  test("Vultr selects available hardware and reviews its monthly cost before one write", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run();

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toEqual([
      { available_only: true, type: "shared_cpu", region_id: "test-region" },
    ]);
    expect(setup.creates).toEqual([
      {
        plan_id: "shared-small",
        region_id: "test-region",
        image_id: "101",
        label: "vpsctl-instance",
      },
    ]);
    expect(result.confirmations).toEqual(["Create this billable instance?"]);
    const review_event = result.events.findIndex((value) =>
      value.includes("$ 6/month"),
    );
    expect(review_event).toBeGreaterThanOrEqual(0);
    expect(review_event).toBeLessThan(result.events.indexOf("confirmed"));
    expect(result.review).toContain("Account: vultr");
    expect(result.review).toContain("shared-small");
    expect(result.review).toContain("Image: Example Linux (101)");
    expect(result.review).toContain("pricing can change");
    const picker = result.selections.find(
      (entry) => entry.message === "Choose a machine",
    );
    expect(picker?.options[0]?.label).toContain("$ 6/month");
    expect(picker?.prompt_options?.searchable).toBe(true);
    expect(setup.connections).toBe(1);
  });

  test("the category picker excludes bare metal, which has no create integration", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run();
    expect(
      result.selections
        .find((entry) => entry.message === "Choose a machine type")
        ?.options.map((option) => option.value),
    ).toEqual(["shared_cpu", "dedicated_cpu", "gpu"]);
  });

  test("RunPod quotes the requested GPU count without inventing a monthly cost", async () => {
    const setup = await fixture("runpod");
    const result = await setup.run([], {
      text: {
        "GPU count": "3",
        "Container disk size (GB)": "60",
        "Persistent volume size (GB)": "20",
        "Docker image": "example/image:latest",
        "Instance label": "sample-gpu",
      },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toEqual([
      { available_only: true, type: "gpu", gpu_count: 3 },
    ]);
    expect(setup.creates).toEqual([
      {
        plan_id: "gpu-example",
        gpu_count: 3,
        disk_gb: 60,
        volume_gb: 20,
        image_id: "example/image:latest",
        label: "sample-gpu",
      },
    ]);
    expect(result.review).toContain("$ 2.25/hour");
    expect(result.review).not.toContain("/month");
    expect(result.review).toContain("Persistent volume: 20 GB");
    expect(result.review).toContain("60 GB");
    expect(result.review).toContain("storage and other charges are extra");
    expect(setup.reads).not.toContain("images");
  });

  test("Vast searches the requested offer with allocated disk before showing its quote", async () => {
    const setup = await fixture("vast");
    const result = await setup.run(["--offer", "321", "--disk-gb", "80"]);

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toEqual([
      { available_only: true, type: "gpu", id: "321", disk_gb: 80 },
    ]);
    expect(setup.creates[0]).toMatchObject({
      offer_id: "321",
      disk_gb: 80,
      image_id: "example/image:latest",
    });
    expect(result.review).toContain("$ 0.75/hour");
    expect(result.review).toContain("requested disk allocation");
    expect(result.text_prompts).not.toContain("Container disk size (GB)");
    expect(result.selections.map((entry) => entry.message)).not.toContain(
      "Choose a machine",
    );
    expect(setup.reads).toEqual(["machines"]);
  });

  test("explicit Vultr flags survive the wizard and still require a live quote", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run([
      "--plan",
      "shared-small",
      "--region",
      "test-region",
      "--image",
      "101",
      "--label",
      "explicit-label",
      "--hostname",
      "example-host",
      "--tag",
      "example-tag",
      "--ssh-key",
      "example-key",
      "--enable-ipv6",
    ]);

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toEqual([
      { available_only: true, id: "shared-small", region_id: "test-region" },
    ]);
    expect(setup.creates).toEqual([
      {
        plan_id: "shared-small",
        region_id: "test-region",
        image_id: "101",
        label: "explicit-label",
        hostname: "example-host",
        tags: ["example-tag"],
        ssh_key_ids: ["example-key"],
        enable_ipv6: true,
      },
    ]);
    expect(result.selections.map((entry) => entry.message)).toEqual([
      "What next?",
    ]);
    expect(result.text_prompts).toEqual([]);
    expect(result.confirmations).toHaveLength(1);
    expect(result.review).toContain("Hostname: example-host");
    expect(result.review).toContain('Tags: ["example-tag"]');
    expect(result.review).toContain('SSH key IDs: ["example-key"]');
    expect(result.review).toContain("IPv6 enabled: yes");
  });

  test("the account is chosen once and reused for discovery and creation", async () => {
    const setup = await fixture("vultr", { pick_account: true });
    const result = await setup.run();
    expect(result.exit_code).toBe(0);
    expect(
      result.selections.filter(
        (entry) => entry.message === "Choose an account",
      ),
    ).toHaveLength(1);
    expect(setup.connections).toBe(1);
    expect(setup.creates).toHaveLength(1);
  });

  test("a declined cost confirmation exits without creating", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run([], { confirmation: false });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("cancelled");
    expect(result.review).toContain("$ 6/month");
    expect(setup.creates).toEqual([]);
  });

  for (const prompt of [
    "Requirements",
    "Choose a machine",
    "Instance label",
    "What next?",
    "Create this billable instance?",
  ]) {
    test(`cancelling ${prompt} does not write`, async () => {
      const setup = await fixture("vultr");
      const result = await setup.run([], { cancel_prompt: prompt });
      expect(result.exit_code).toBe(130);
      expect(setup.creates).toEqual([]);
    });
  }

  test("a failed discovery never asks for billing confirmation or creates", async () => {
    const setup = await fixture("vultr");
    setup.failDiscovery(new AppError("network_error", "Catalog unavailable."));
    const result = await setup.run();
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("Catalog unavailable.");
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("no available machines offers recovery without confirmation", async () => {
    const setup = await fixture("vultr");
    setup.setMachines([]);
    const result = await setup.run([], {
      selections: { "No matching machines": "cancel" },
    });
    expect(result.exit_code).toBe(130);
    expect(result.review).toContain("No available machines");
    expect(
      result.selections
        .find((entry) => entry.message === "No matching machines")
        ?.options.map((option) => option.value),
    ).toEqual(["requirements", "cancel"]);
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("unavailable and unknown stock cannot be chosen even if the provider ignores filters", async () => {
    const setup = await fixture("vultr");
    setup.setMachines(
      [
        { ...machine("vultr"), availability: "unknown" },
        { ...machine("vultr"), id: "sold-out", availability: "unavailable" },
      ],
      true,
    );
    const result = await setup.run([], {
      selections: { "No matching machines": "cancel" },
    });
    expect(result.exit_code).toBe(130);
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("missing prices are explicitly disclosed without made-up amounts", async () => {
    const setup = await fixture("vultr");
    const { monthly_cost: _, ...without_price } = machine("vultr");
    setup.setMachines([without_price]);
    const result = await setup.run();
    expect(result.exit_code).toBe(0);
    expect(result.review).toContain("Price unavailable");
    expect(result.review).not.toContain("$ 0");
    expect(setup.creates).toHaveLength(1);
  });

  test("duplicate available machine IDs fail without a billing confirmation", async () => {
    const setup = await fixture("vultr");
    setup.setMachines([machine("vultr"), machine("vultr")]);
    const result = await setup.run();
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("duplicate machine IDs");
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("a requested offer cannot silently be substituted by the catalog", async () => {
    const setup = await fixture("vast");
    setup.setMachines([{ ...machine("vast"), id: "654" }], true);
    const result = await setup.run(["--offer", "321"]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("requested machine is unavailable");
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("an invalid selection from a prompt cannot create an unlisted machine", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run([], {
      selections: { "Choose a machine": "not-listed" },
    });
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("Choose one of the available options");
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("provider-only fields and credentials are excluded from the review", async () => {
    const setup = await fixture("vultr");
    const with_private_fields = {
      ...machine("vultr"),
      private_token: "do-not-display-provider-secret",
      env: { ACCESS_KEY: "do-not-display-environment-secret" },
    };
    setup.setMachines([with_private_fields]);
    const result = await setup.run();
    expect(result.exit_code).toBe(0);
    const visible = `${result.stdout}\n${result.review}`;
    expect(visible).not.toContain("do-not-display");
    expect(visible).not.toContain("synthetic-api-key");
    expect(visible).not.toContain("private_token");
  });
});

describe("requirements-first creation wizard", () => {
  for (const provider_id of ["vultr", "runpod", "vast"] as const) {
    test(`${provider_id} gathers requirements before comparing matching machines`, async () => {
      const setup = await fixture(provider_id);
      const result = await setup.run([], {
        selections: {
          Requirements: ["min_vcpu", "min_memory_gb", "compare"],
        },
        text: {
          "Minimum vCPUs": "2",
          "Minimum RAM (GB)": "4",
        },
      });

      expect(result.exit_code).toBe(0);
      expect(setup.trace.indexOf("text:Minimum vCPUs")).toBeLessThan(
        setup.trace.indexOf("read:machines"),
      );
      expect(setup.trace.indexOf("text:Minimum RAM (GB)")).toBeLessThan(
        setup.trace.indexOf("read:machines"),
      );
      expect(setup.queries).toHaveLength(1);
      expect(result.note_titles).toContain("Requirements");
      expect(
        result.selections.find((entry) => entry.message === "Choose a machine")
          ?.prompt_options?.searchable,
      ).toBe(true);
      expect(setup.creates).toHaveLength(1);
      if (provider_id === "runpod") {
        expect(
          setup.trace.indexOf("text:Container disk size (GB)"),
        ).toBeGreaterThan(setup.trace.indexOf("select:Choose a machine"));
      }
      if (provider_id === "vast") {
        expect(
          setup.trace.indexOf("text:Container disk size (GB)"),
        ).toBeLessThan(setup.trace.indexOf("read:machines"));
      }
    });
  }

  test("CPU and RAM requirements exclude insufficient or unknown specifications", async () => {
    const setup = await fixture("vultr");
    const { vcpu_count: _, memory_mb: __, ...unknown_specs } = machine("vultr");
    setup.setMachines(
      [
        { ...machine("vultr"), id: "too-small" },
        { ...unknown_specs, id: "unknown-specs" },
        {
          ...machine("vultr"),
          id: "matching-plan",
          vcpu_count: 4,
          memory_mb: 8192,
        },
      ],
      true,
    );
    const result = await setup.run([], {
      selections: {
        Requirements: ["min_vcpu", "min_memory_gb", "compare"],
      },
      text: { "Minimum vCPUs": "4", "Minimum RAM (GB)": "8" },
    });

    expect(result.exit_code).toBe(0);
    const choices = result.selections.find(
      (entry) => entry.message === "Choose a machine",
    )?.options;
    expect(choices?.map((option) => option.value)).toEqual([
      "matching-plan",
      "__back__",
    ]);
    expect(setup.creates[0]?.plan_id).toBe("matching-plan");
    expect(setup.queries[0]).toEqual({
      available_only: true,
      type: "shared_cpu",
      region_id: "test-region",
      min_vcpu: 4,
      min_memory_gb: 8,
    });
  });

  test("GPU memory requirements exclude missing and undersized GPU memory", async () => {
    const setup = await fixture("runpod");
    setup.setMachines(
      [
        { ...machine("runpod"), id: "unknown-memory" },
        { ...machine("runpod"), id: "small-memory", gpu_memory_gb: 12 },
        { ...machine("runpod"), id: "matching-gpu", gpu_memory_gb: 24 },
      ],
      true,
    );
    const result = await setup.run([], {
      selections: {
        Requirements: ["min_gpu_memory_gb", "compare"],
      },
      text: { "Minimum GPU memory (GB)": "24" },
    });

    expect(result.exit_code).toBe(0);
    expect(
      result.selections
        .find((entry) => entry.message === "Choose a machine")
        ?.options.map((option) => option.value),
    ).toEqual(["matching-gpu", "__back__"]);
    expect(setup.creates[0]?.plan_id).toBe("matching-gpu");
    expect(setup.queries[0]?.min_gpu_memory_gb).toBe(24);
  });

  test("machine comparison sorts comparable prices and leaves unpriced machines last", async () => {
    const setup = await fixture("vultr");
    const { monthly_cost: _, ...unpriced } = machine("vultr");
    setup.setMachines([
      { ...machine("vultr"), id: "expensive", monthly_cost: 12 },
      { ...unpriced, id: "unknown-price" },
      { ...machine("vultr"), id: "zeta", monthly_cost: 6 },
      { ...machine("vultr"), id: "alpha", monthly_cost: 6 },
      { ...machine("vultr"), id: "cheapest", monthly_cost: 3 },
    ]);
    const result = await setup.run();

    expect(result.exit_code).toBe(0);
    const picker = result.selections.find(
      (entry) => entry.message === "Choose a machine",
    );
    expect(picker?.options.map((option) => option.value)).toEqual([
      "cheapest",
      "alpha",
      "zeta",
      "expensive",
      "unknown-price",
      "__back__",
    ]);
    expect(picker?.prompt_options?.searchable).toBe(true);
    expect(picker?.options[0]?.label).toContain("$ 3/month");
    expect(setup.creates[0]?.plan_id).toBe("cheapest");
  });

  test("Back to requirements changes the category and refreshes matching machines", async () => {
    const setup = await fixture("vultr");
    setup.setMachines([
      machine("vultr"),
      {
        ...machine("vultr"),
        id: "dedicated-large",
        type: "dedicated_cpu",
        monthly_cost: 30,
      },
    ]);
    const result = await setup.run([], {
      selections: {
        "Choose a machine type": ["shared_cpu", "dedicated_cpu"],
        Requirements: ["compare", "type", "compare"],
        "Choose a machine": ["__back__", "dedicated-large"],
      },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries.map((query) => query.type)).toEqual([
      "shared_cpu",
      "dedicated_cpu",
    ]);
    expect(setup.creates).toHaveLength(1);
    expect(setup.creates[0]?.plan_id).toBe("dedicated-large");
    expect(result.confirmations).toEqual(["Create this billable instance?"]);
  });

  test("requirements changed from review invalidate the machine and refresh its GPU quote", async () => {
    const setup = await fixture("runpod");
    setup.setMachines([
      machine("runpod"),
      { ...machine("runpod"), id: "gpu-next" },
    ]);
    const result = await setup.run([], {
      selections: {
        Requirements: ["compare", "gpu_count", "compare"],
        "Choose a machine": ["gpu-example", "gpu-next"],
        "What next?": ["requirements", "continue"],
      },
      text: { "GPU count": ["1", "3"] },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toEqual([
      { available_only: true, type: "gpu", gpu_count: 1 },
      { available_only: true, type: "gpu", gpu_count: 3 },
    ]);
    expect(setup.creates).toHaveLength(1);
    expect(setup.creates[0]).toMatchObject({
      plan_id: "gpu-next",
      gpu_count: 3,
      image_id: "example/image:latest",
      disk_gb: 40,
    });
    expect(result.review).toContain("$ 0.75/hour");
    expect(result.review).toContain("$ 2.25/hour");
    expect(
      result.text_prompts.filter((prompt) => prompt === "Docker image"),
    ).toHaveLength(1);
  });

  test("no-match recovery lets users relax requirements and compare again", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run([], {
      selections: {
        Requirements: ["min_memory_gb", "compare", "min_memory_gb", "compare"],
        "No matching machines": "requirements",
      },
      text: { "Minimum RAM (GB)": ["128", "4"] },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toHaveLength(2);
    expect(
      result.selections.filter(
        (entry) => entry.message === "No matching machines",
      ),
    ).toHaveLength(1);
    expect(
      result.selections.filter((entry) => entry.message === "Choose a machine"),
    ).toHaveLength(1);
    expect(setup.creates).toHaveLength(1);
    expect(result.confirmations).toHaveLength(1);
  });

  test("zero clears a minimum requirement after an empty comparison", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run([], {
      selections: {
        Requirements: ["min_vcpu", "compare", "min_vcpu", "compare"],
        "No matching machines": "requirements",
      },
      text: { "Minimum vCPUs": ["4", "0"] },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toHaveLength(2);
    expect(setup.creates[0]?.plan_id).toBe("shared-small");
    expect(result.review).toContain("Minimum vCPUs: Any");
    expect(setup.queries[0]?.min_vcpu).toBe(4);
    expect(setup.queries[1]).not.toHaveProperty("min_vcpu");
  });

  test("a provider machine ID cannot collide with Back navigation", async () => {
    const setup = await fixture("runpod");
    setup.setMachines([{ ...machine("runpod"), id: "__back__" }]);
    const result = await setup.run();

    expect(result.exit_code).toBe(0);
    const choices = result.selections.find(
      (entry) => entry.message === "Choose a machine",
    )?.options;
    expect(choices?.[0]?.value).toBe("__back__");
    expect(choices?.at(-1)?.value).not.toBe("__back__");
    expect(choices?.at(-1)?.label).toBe("Back to requirements");
    expect(setup.creates[0]?.plan_id).toBe("__back__");
    expect(setup.queries).toHaveLength(1);
  });

  for (const timing of ["before", "during"] as const) {
    test(`cancelling ${timing} machine discovery stops before selection or creation`, async () => {
      const setup = await fixture("vultr");
      const before = await readFile(setup.config_path, "utf8");
      const result = await setup.run([], {
        cancel_progress: { message: "Finding matching machines", timing },
      });

      expect(result.exit_code).toBe(130);
      expect(setup.queries).toHaveLength(timing === "before" ? 0 : 1);
      expect(result.progress_events).toContain(
        "fail:Finding matching machines",
      );
      expect(
        result.selections.some((entry) => entry.message === "Choose a machine"),
      ).toBe(false);
      expect(setup.creates).toEqual([]);
      expect(result.confirmations).toEqual([]);
      expect(await readFile(setup.config_path, "utf8")).toBe(before);
    });
  }

  test("a different machine can be chosen from review without repeating discovery or configuration", async () => {
    const setup = await fixture("vultr");
    setup.setMachines([
      machine("vultr"),
      { ...machine("vultr"), id: "shared-large", monthly_cost: 12 },
    ]);
    const result = await setup.run([], {
      selections: {
        "What next?": ["machine", "continue"],
        "Choose a machine": ["shared-small", "shared-large"],
      },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toHaveLength(1);
    expect(setup.creates[0]?.plan_id).toBe("shared-large");
    expect(
      result.text_prompts.filter((prompt) => prompt === "Instance label"),
    ).toHaveLength(1);
    expect(setup.reads.filter((read) => read === "images")).toHaveLength(1);
  });

  test("editing a supplied label retains all other supplied configuration", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run(
      [
        "--plan",
        "shared-small",
        "--region",
        "test-region",
        "--image",
        "101",
        "--label",
        "original-label",
        "--hostname",
        "example-host",
        "--tag",
        "example-tag",
        "--ssh-key",
        "example-key",
        "--enable-ipv6",
      ],
      {
        selections: {
          "What next?": ["configuration", "continue"],
          "Edit configuration": ["label", "done"],
        },
        text: { "Instance label": "updated-label" },
      },
    );

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toHaveLength(1);
    expect(setup.creates).toEqual([
      {
        plan_id: "shared-small",
        region_id: "test-region",
        image_id: "101",
        label: "updated-label",
        hostname: "example-host",
        tags: ["example-tag"],
        ssh_key_ids: ["example-key"],
        enable_ipv6: true,
      },
    ]);
    expect(
      result.text_prompt_options.find(
        (entry) => entry.message === "Instance label",
      )?.options?.initial_value,
    ).toBe("original-label");
    expect(result.confirmations).toHaveLength(1);
  });

  test("editing an unsafe supplied label displays safe text without prefilling control characters", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run(
      [
        "--plan",
        "shared-small",
        "--region",
        "test-region",
        "--image",
        "101",
        "--label",
        "unsafe\u001b[31mlabel",
      ],
      {
        selections: {
          "What next?": ["configuration", "continue"],
          "Edit configuration": ["label", "done"],
        },
        text: { "Instance label": "safe-label" },
      },
    );

    expect(result.exit_code).toBe(0);
    expect(result.review).toContain("Label: unsafe [31mlabel");
    expect(result.review).not.toContain("\u001b");
    expect(
      result.text_prompt_options.find(
        (entry) => entry.message === "Instance label",
      )?.options?.initial_value,
    ).toBeUndefined();
    expect(setup.creates[0]?.label).toBe("safe-label");
    expect(result.confirmations).toHaveLength(1);
  });

  test("changing requirements after an exact plan infers its category and clears the pinned plan", async () => {
    const setup = await fixture("vultr");
    setup.setMachines([
      machine("vultr"),
      { ...machine("vultr"), id: "shared-large", monthly_cost: 12 },
    ]);
    const result = await setup.run(
      [
        "--plan",
        "shared-small",
        "--region",
        "test-region",
        "--image",
        "101",
        "--label",
        "example-instance",
      ],
      {
        selections: {
          "What next?": ["requirements", "continue"],
          "Choose a machine": "shared-large",
        },
      },
    );

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toEqual([
      { available_only: true, id: "shared-small", region_id: "test-region" },
      { available_only: true, type: "shared_cpu", region_id: "test-region" },
    ]);
    expect(result.review).toContain("Machine type: Shared CPU");
    expect(setup.creates).toHaveLength(1);
    expect(setup.creates[0]).toMatchObject({
      plan_id: "shared-large",
      image_id: "101",
      label: "example-instance",
    });
    expect(result.text_prompts).toEqual([]);
  });

  test("RunPod storage edits retain hardware and supplied access flags", async () => {
    const setup = await fixture("runpod");
    const result = await setup.run(
      [
        "--disk-gb",
        "40",
        "--volume-gb",
        "0",
        "--image",
        "example/image:latest",
        "--port",
        "22/tcp",
        "--ssh",
      ],
      {
        selections: {
          "What next?": ["configuration", "continue"],
          "Edit configuration": ["disk_gb", "volume_gb", "done"],
        },
        text: {
          "Container disk size (GB)": "80",
          "Persistent volume size (GB)": "20",
        },
      },
    );

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toHaveLength(1);
    expect(setup.creates[0]).toMatchObject({
      plan_id: "gpu-example",
      gpu_count: 1,
      disk_gb: 80,
      volume_gb: 20,
      image_id: "example/image:latest",
      ports: ["22/tcp"],
      enable_ssh: true,
    });
    expect(result.review).toContain("Persistent volume: 20 GB");
  });

  test("changing Vast disk requirements refreshes the offer quote and retains configuration", async () => {
    const setup = await fixture("vast");
    setup.setMachines([
      machine("vast"),
      { ...machine("vast"), id: "654", hourly_cost: 1 },
    ]);
    const result = await setup.run([], {
      selections: {
        Requirements: ["compare", "disk_gb", "compare"],
        "Choose a machine": ["321", "654"],
        "What next?": ["requirements", "continue"],
      },
      text: { "Container disk size (GB)": ["40", "80"] },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toEqual([
      { available_only: true, type: "gpu", disk_gb: 40 },
      { available_only: true, type: "gpu", disk_gb: 80 },
    ]);
    expect(setup.creates).toHaveLength(1);
    expect(setup.creates[0]).toMatchObject({
      offer_id: "654",
      disk_gb: 80,
      image_id: "example/image:latest",
      label: "vpsctl-instance",
    });
    expect(
      result.text_prompts.filter((prompt) => prompt === "Docker image"),
    ).toHaveLength(1);
  });

  test("catalog region and image choices support search", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run();

    expect(result.exit_code).toBe(0);
    for (const message of ["Choose a region", "Choose an image"]) {
      expect(
        result.selections.find((entry) => entry.message === message)
          ?.prompt_options?.searchable,
      ).toBe(true);
    }
  });

  test("configuration can return to machine comparison before confirmation", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run([], {
      selections: {
        "What next?": ["configuration", "continue"],
        "Edit configuration": "machine",
      },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toHaveLength(1);
    expect(
      result.selections.filter((entry) => entry.message === "Choose a machine"),
    ).toHaveLength(2);
    expect(setup.creates).toHaveLength(1);
  });

  for (const prompt of ["Requirements", "What next?"]) {
    test(`choosing cancel from ${prompt} leaves accounts and resources unchanged`, async () => {
      const setup = await fixture("vultr");
      const before = await readFile(setup.config_path, "utf8");
      const result = await setup.run([], {
        selections: { [prompt]: "cancel" },
      });

      expect(result.exit_code).toBe(130);
      expect(setup.creates).toEqual([]);
      expect(result.confirmations).toEqual([]);
      expect(await readFile(setup.config_path, "utf8")).toBe(before);
    });
  }

  for (const value of ["-1", "1.5", "9007199254740992"]) {
    test(`invalid minimum requirements fail before discovery: ${value}`, async () => {
      const setup = await fixture("vultr");
      const result = await setup.run([], {
        selections: { Requirements: "min_vcpu" },
        text: { "Minimum vCPUs": value },
      });

      expect(result.exit_code).toBe(1);
      expect(setup.queries).toEqual([]);
      expect(setup.creates).toEqual([]);
      expect(result.confirmations).toEqual([]);
    });
  }
});

describe("guided creation dry runs", () => {
  for (const { provider_id, input, cost } of [
    {
      provider_id: "vultr",
      input: {
        region_id: "test-region",
        plan_id: "shared-small",
        image_id: "101",
        label: "vpsctl-instance",
      },
      cost: "$ 6/month",
    },
    {
      provider_id: "runpod",
      input: {
        gpu_count: 1,
        disk_gb: 40,
        volume_gb: 0,
        plan_id: "gpu-example",
        image_id: "example/image:latest",
        label: "vpsctl-instance",
      },
      cost: "$ 0.75/hour",
    },
    {
      provider_id: "vast",
      input: {
        disk_gb: 40,
        offer_id: "321",
        image_id: "example/image:latest",
        label: "vpsctl-instance",
      },
      cost: "$ 0.75/hour",
    },
  ] as const) {
    test(`${provider_id} guides selection and reviews cost without confirmation or creation`, async () => {
      const setup = await fixture(provider_id);
      const result = await setup.run(["--dry-run"]);

      expect(result.exit_code).toBe(0);
      expect(setup.connections).toBe(1);
      expect(setup.queries).toHaveLength(1);
      expect(result.selections.map((entry) => entry.message)).toContain(
        "Choose a machine",
      );
      expect(result.text_prompts).toContain("Instance label");
      expect(result.review).toContain(cost);
      expect(result.review).toContain("Dry run: no instance will be created.");
      expect(result.note_titles).toContain("Dry-run instance creation");
      expect(result.stdout).toContain("action: instance.create");
      expect(result.stdout).toContain("dry_run: true");
      const input_line = result.stdout
        .split("\n")
        .find((line) => line.startsWith("input: "));
      expect(JSON.parse(input_line?.slice("input: ".length) ?? "{}")).toEqual(
        input,
      );
      expect(result.confirmations).toEqual([]);
      expect(setup.creates).toEqual([]);
    });
  }

  test("the account is chosen once and reused for dry-run discovery", async () => {
    const setup = await fixture("vultr", { pick_account: true });
    const result = await setup.run(["--dry-run"]);
    expect(result.exit_code).toBe(0);
    expect(
      result.selections.filter(
        (entry) => entry.message === "Choose an account",
      ),
    ).toHaveLength(1);
    expect(result.review).toContain("Account: vultr");
    expect(setup.connections).toBe(1);
    expect(setup.queries).toHaveLength(1);
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("a dry run can revise requirements and configuration before its final preview", async () => {
    const setup = await fixture("runpod");
    const result = await setup.run(["--dry-run"], {
      selections: {
        Requirements: ["compare", "gpu_count", "compare"],
        "What next?": ["requirements", "configuration", "continue"],
        "Edit configuration": ["image_id", "done"],
      },
      text: {
        "GPU count": ["1", "3"],
        "Docker image": ["example/image:latest", "example/revised:latest"],
      },
    });

    expect(result.exit_code).toBe(0);
    expect(setup.queries).toHaveLength(2);
    expect(result.review).toContain("$ 2.25/hour");
    const input_line = result.stdout
      .split("\n")
      .find((line) => line.startsWith("input: "));
    expect(
      JSON.parse(input_line?.slice("input: ".length) ?? "{}"),
    ).toMatchObject({
      plan_id: "gpu-example",
      gpu_count: 3,
      image_id: "example/revised:latest",
    });
    expect(result.stdout).toContain("dry_run: true");
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("cancelling at dry-run review does not print a completed preview", async () => {
    const setup = await fixture("vultr");
    const result = await setup.run(["--dry-run"], {
      selections: { "What next?": "cancel" },
    });

    expect(result.exit_code).toBe(130);
    expect(result.stdout).not.toContain("dry_run: true");
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  for (const prompt of [
    "Choose an account",
    "Requirements",
    "Choose a machine",
    "Instance label",
    "What next?",
  ]) {
    test(`cancelling dry-run ${prompt} leaves accounts and resources unchanged`, async () => {
      const setup = await fixture("vultr", { pick_account: true });
      const before = await readFile(setup.config_path, "utf8");
      const result = await setup.run(["--dry-run"], { cancel_prompt: prompt });
      expect(result.exit_code).toBe(130);
      expect(result.stdout).not.toContain("dry_run: true");
      expect(result.confirmations).toEqual([]);
      expect(setup.creates).toEqual([]);
      expect(await readFile(setup.config_path, "utf8")).toBe(before);
    });
  }
});

describe("guided creation script safeguards", () => {
  for (const { label, flags, interactive } of [
    { label: "noninteractive", flags: [], interactive: false },
    { label: "JSON", flags: ["--json"], interactive: true },
    { label: "--yes", flags: ["--yes"], interactive: true },
  ]) {
    test(`${label} dry-run is offline and does not require the configured credential`, async () => {
      const setup = await fixture("vultr", { missing_credential: true });
      const result = await setup.run(
        [
          "--dry-run",
          ...flags,
          "--region",
          "test-region",
          "--plan",
          "shared-small",
          "--image",
          "101",
        ],
        { interactive },
      );
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("dry_run");
      expect(setup.connections).toBe(0);
      expect(setup.reads).toEqual([]);
      expect(result.selections).toEqual([]);
      expect(result.text_prompts).toEqual([]);
      expect(result.confirmations).toEqual([]);
      expect(setup.creates).toEqual([]);
    });
  }

  for (const flags of [["--yes"], ["--json", "--yes"]]) {
    test(`${flags.join(" ")} stays fully flag-driven without discovery`, async () => {
      const setup = await fixture("runpod");
      const result = await setup.run([
        ...flags,
        "--plan",
        "gpu-example",
        "--image",
        "example/image:latest",
        "--label",
        "script-instance",
        "--disk-gb",
        "40",
      ]);
      expect(result.exit_code).toBe(0);
      expect(setup.reads).toEqual([]);
      expect(result.selections).toEqual([]);
      expect(result.text_prompts).toEqual([]);
      expect(result.confirmations).toEqual([]);
      expect(setup.creates).toHaveLength(1);
      if (flags.includes("--json")) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          account_id: "sample-runpod",
          action: "instance.create",
        });
      }
    });
  }

  test("complete JSON creation on a TTY requires --yes without prompting", async () => {
    const setup = await fixture("runpod", { missing_credential: true });
    const result = await setup.run([
      "--json",
      "--plan",
      "gpu-example",
      "--image",
      "example/image:latest",
      "--label",
      "script-instance",
      "--disk-gb",
      "40",
    ]);
    expect(result.exit_code).toBe(1);
    expect(JSON.parse(result.stderr).error.message).toContain("--yes");
    expect(setup.connections).toBe(0);
    expect(setup.reads).toEqual([]);
    expect(result.selections).toEqual([]);
    expect(result.text_prompts).toEqual([]);
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  for (const flags of [
    ["--yes"],
    ["--json"],
    ["--dry-run", "--json"],
    ["--dry-run", "--yes"],
  ]) {
    test(`${flags.join(" ")} does not fill missing flags using prompts`, async () => {
      const setup = await fixture("runpod");
      const result = await setup.run(flags);
      expect(result.exit_code).toBe(1);
      expect(setup.connections).toBe(0);
      expect(setup.reads).toEqual([]);
      expect(result.text_prompts).toEqual([]);
      expect(result.selections).toEqual([]);
      expect(setup.creates).toEqual([]);
    });
  }

  for (const flags of [
    ["--yes"],
    ["--dry-run", "--yes"],
    ["--dry-run", "--json"],
    ["--json", "--yes"],
  ]) {
    test(`${flags.join(" ")} requires an explicit or default account instead of opening an account picker`, async () => {
      const setup = await fixture("vultr", { pick_account: true });
      const result = await setup.run([
        ...flags,
        "--region",
        "test-region",
        "--plan",
        "shared-small",
        "--image",
        "101",
      ]);
      expect(result.exit_code).toBe(1);
      expect(setup.connections).toBe(0);
      expect(setup.reads).toEqual([]);
      expect(result.selections).toEqual([]);
      expect(result.text_prompts).toEqual([]);
      expect(result.confirmations).toEqual([]);
      expect(setup.creates).toEqual([]);
    });
  }

  for (const { provider_id, flags } of [
    { provider_id: "vultr", flags: ["--image", "not-an-os-id"] },
    { provider_id: "runpod", flags: ["--hostname", "unsupported-host"] },
    { provider_id: "runpod", flags: ["--volume-gb", "3"] },
    { provider_id: "vast", flags: ["--offer", "not-an-offer-id"] },
    { provider_id: "vast", flags: ["--region", "unsupported-region"] },
  ] as const) {
    test(`${provider_id} rejects supplied invalid options before credentials or discovery: ${flags.join(" ")}`, async () => {
      const setup = await fixture(provider_id, { missing_credential: true });
      const result = await setup.run([...flags]);
      expect(result.exit_code).toBe(1);
      expect(result.stderr).not.toContain("UNSET_TEST_TOKEN");
      expect(setup.connections).toBe(0);
      expect(setup.reads).toEqual([]);
      expect(result.selections).toEqual([]);
      expect(result.text_prompts).toEqual([]);
      expect(result.confirmations).toEqual([]);
      expect(setup.creates).toEqual([]);
    });
  }

  test("invalid prompted values fail full validation without confirming or creating", async () => {
    const setup = await fixture("runpod");
    const result = await setup.run([], {
      text: { "Docker image": "invalid image with spaces" },
    });
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("image_id");
    expect(result.confirmations).toEqual([]);
    expect(setup.creates).toEqual([]);
  });

  test("noninteractive creation still requires explicit confirmation flags", async () => {
    const setup = await fixture("vast");
    const result = await setup.run(
      ["--offer", "321", "--image", "example/image:latest", "--disk-gb", "40"],
      { interactive: false },
    );
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("require --yes");
    expect(setup.connections).toBe(0);
    expect(setup.reads).toEqual([]);
    expect(result.selections).toEqual([]);
    expect(result.text_prompts).toEqual([]);
    expect(setup.creates).toEqual([]);
  });
});
