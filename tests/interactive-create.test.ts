import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptOption } from "../src/commands/context.ts";
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
  selections?: Record<string, string>;
  text?: Record<string, string>;
  cancel_prompt?: string;
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
  let connections = 0;
  let machines = [machine(provider_id)];
  let discovery_error: AppError | undefined;
  let raw_discovery = false;
  const definition = new ProviderRegistry().get(provider_id);
  const provider: Provider = {
    info: definition.info,
    async listMachines(query = {}) {
      reads.push("machines");
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
      return [{ id: "test-region", name: "Example region", country: "XX" }];
    },
    async listImages() {
      reads.push("images");
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
    const output: string[] = [];
    const errors: string[] = [];
    const notes: string[] = [];
    const note_titles: string[] = [];
    const events: string[] = [];
    const text_prompts: string[] = [];
    const selections: { message: string; options: PromptOption[] }[] = [];
    const confirmations: string[] = [];
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
      async select(message, choices) {
        cancelled(message);
        selections.push({ message, options: choices });
        return options.selections?.[message] ?? choices[0]?.value ?? "";
      },
      async read_text(message, prompt_options) {
        cancelled(message);
        text_prompts.push(message);
        return (
          options.text?.[message] ??
          prompt_options?.initial_value ??
          (message === "Docker image" ? "example/image:latest" : "")
        );
      },
      note(message, title) {
        notes.push(message);
        if (title) note_titles.push(title);
        events.push(message);
      },
      async confirm(message) {
        cancelled(message);
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
      selections,
      confirmations,
    };
  };
  return {
    config_path,
    run,
    creates,
    queries,
    reads,
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
    expect(picker?.options[0]?.hint).toContain("$ 6/month");
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
    expect(result.selections).toEqual([]);
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
    "Choose a machine",
    "Instance label",
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

  test("no available machines produces an actionable error without confirmation", async () => {
    const setup = await fixture("vultr");
    setup.setMachines([]);
    const result = await setup.run();
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("No available machines");
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
    const result = await setup.run();
    expect(result.exit_code).toBe(1);
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
      expect(result.note_titles).toEqual(["Dry-run instance creation"]);
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

  for (const prompt of [
    "Choose an account",
    "Choose a machine",
    "Instance label",
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
