import { AppError } from "../core/errors.ts";
import type {
  CreateInstanceInput,
  EditInstanceInput,
  Provider,
} from "../core/provider.ts";
import type { CliCommand } from "./command.ts";
import type { CommandContext, CommonOptions } from "./context.ts";
import { collect, instanceId, nonblank, summary } from "./input.ts";
import { render } from "./output.ts";

export function registerInstanceCommands(
  program: CliCommand,
  context: CommandContext,
): void {
  const {
    env,
    io,
    registry,
    print,
    storeFor,
    readProvider,
    mutate,
    mutationFlags,
    setExitCode,
  } = context;
  const instances = program
    .command("instance")
    .description("Create, inspect, and control VPS instances");
  const list = instances
    .command("list")
    .description("List instances for one account or all registered accounts")
    .option(
      "--all-accounts",
      "Aggregate inventory across every configured account",
    );
  list.action(async () => {
    const flags = list.optsWithGlobals<
      CommonOptions & { all_accounts?: boolean }
    >();
    if (!flags.all_accounts) {
      await readProvider(list, "instance.list", async (provider) => {
        const items = await provider.listInstances();
        return flags.json ? items : items.map(summary);
      });
      return;
    }
    if (flags.account || env.VPS_CTL_ACCOUNT) {
      throw new AppError(
        "invalid_input",
        "--all-accounts cannot be combined with --account or VPS_CTL_ACCOUNT.",
      );
    }
    const config = await storeFor(list).read();
    const results = await Promise.all(
      config.accounts.map(async (account) => {
        try {
          return {
            account_id: account.id,
            provider_id: account.provider_id,
            instances: await registry.connect(account, env).listInstances(),
          };
        } catch (error) {
          setExitCode(1);
          return {
            account_id: account.id,
            provider_id: account.provider_id,
            error:
              error instanceof Error
                ? error.message
                : "Account request failed.",
          };
        }
      }),
    );
    if (flags.json) {
      print(list, "instance.list", results);
    } else {
      for (const result of results) {
        io.write_out(`Account: ${result.account_id} (${result.provider_id})\n`);
        io.write_out(
          `${result.instances ? render(result.instances.map(summary)) : `Error: ${result.error}`}\n`,
        );
      }
      if (results.length === 0)
        io.write_out("No accounts configured. Run 'account add'.\n");
    }
  });
  const get = instances
    .command("get <id>")
    .description("Get normalized instance details");
  get.action((id: string) =>
    readProvider(get, "instance.get", (provider) =>
      provider.getInstance(instanceId(id)),
    ),
  );

  const create = mutationFlags(
    instances
      .command("create")
      .alias("buy")
      .description("Provision a new billable instance")
      .requiredOption("--region <id>", "Region from catalog regions")
      .requiredOption("--plan <id>", "Plan from catalog plans")
      .requiredOption("--image <id>", "OS image from catalog images")
      .option("--label <label>", "Instance label")
      .option("--hostname <hostname>", "Hostname set during provisioning")
      .option(
        "--ssh-key <id>",
        "Registered SSH key ID; repeat to add keys",
        collect,
      )
      .option("--tag <tag>", "Tag; repeat to add tags", collect)
      .option("--enable-ipv6", "Enable IPv6"),
  );
  create.action(async () => {
    const flags = create.opts<{
      region: string;
      plan: string;
      image: string;
      label?: string;
      hostname?: string;
      ssh_key?: string[];
      tag?: string[];
      enable_ipv6?: boolean;
    }>();
    const input: CreateInstanceInput = {
      region_id: nonblank(flags.region, "Region"),
      plan_id: nonblank(flags.plan, "Plan"),
      image_id: nonblank(flags.image, "Image"),
      ...(flags.label !== undefined
        ? { label: nonblank(flags.label, "Label") }
        : {}),
      ...(flags.hostname !== undefined
        ? { hostname: nonblank(flags.hostname, "Hostname") }
        : {}),
      ...(flags.ssh_key
        ? { ssh_key_ids: flags.ssh_key.map((id) => nonblank(id, "SSH key")) }
        : {}),
      ...(flags.tag
        ? { tags: flags.tag.map((tag) => nonblank(tag, "Tag")) }
        : {}),
      ...(flags.enable_ipv6 !== undefined
        ? { enable_ipv6: flags.enable_ipv6 }
        : {}),
    };
    await mutate(create, {
      action: "instance.create",
      input,
      notice:
        "Creates a billable instance. Provisioning continues after the request is accepted.",
      execute: (provider) => provider.createInstance(input),
    });
  });

  const edit = mutationFlags(
    instances
      .command("edit <id>")
      .description("Update labels, replace tags, or change plan")
      .option("--label <label>", "New label")
      .option(
        "--tag <tag>",
        "Replace tags with this list; repeat for more tags",
        collect,
      )
      .option("--clear-tags", "Remove every tag")
      .option(
        "--plan <id>",
        "Resize to another plan; provider restrictions apply",
      ),
  );
  edit.action(async (id: string) => {
    instanceId(id);
    const flags = edit.opts<{
      label?: string;
      tag?: string[];
      clear_tags?: boolean;
      plan?: string;
    }>();
    if (flags.tag && flags.clear_tags)
      throw new AppError(
        "invalid_input",
        "Use --tag or --clear-tags, not both.",
      );
    const input: EditInstanceInput = {
      ...(flags.label !== undefined
        ? { label: nonblank(flags.label, "Label") }
        : {}),
      ...(flags.plan !== undefined
        ? { plan_id: nonblank(flags.plan, "Plan") }
        : {}),
      ...(flags.clear_tags
        ? { tags: [] }
        : flags.tag
          ? { tags: flags.tag.map((tag) => nonblank(tag, "Tag")) }
          : {}),
    };
    if (Object.keys(input).length === 0)
      throw new AppError(
        "invalid_input",
        "Provide --label, --tag, --clear-tags, or --plan.",
      );
    await mutate(edit, {
      action: "instance.edit",
      instance_id: id,
      input,
      notice: input.plan_id
        ? "Plan changes may increase charges and restart the instance. Provider resize restrictions apply."
        : "Applies only the supplied fields; a tag list replaces all existing tags.",
      execute: (provider) => provider.editInstance(id, input),
    });
  });

  for (const [name, description, notice, execute] of [
    [
      "start",
      "Start an instance",
      "Powers on the instance.",
      (provider: Provider, id: string) => provider.startInstance(id),
    ],
    [
      "stop",
      "Stop an instance",
      "Powers off the instance.",
      (provider: Provider, id: string) => provider.stopInstance(id),
    ],
    [
      "reboot",
      "Reboot an instance",
      "Restarts the instance and interrupts running workloads.",
      (provider: Provider, id: string) => provider.rebootInstance(id),
    ],
    [
      "destroy",
      "Permanently delete an instance",
      "Permanently destroys this instance and its local data and releases its IP address.",
      (provider: Provider, id: string) => provider.destroyInstance(id),
    ],
  ] as const) {
    const command = mutationFlags(
      instances.command(`${name} <id>`).description(description),
    );
    command.action(async (id: string) =>
      mutate(command, {
        action: `instance.${name}`,
        instance_id: instanceId(id),
        notice,
        execute: (provider) => execute(provider, id),
      }),
    );
  }
}
