# vps-ctl

A Bun + TypeScript CLI for managing compute instances across multiple local accounts: Vultr Cloud Compute, RunPod GPU Pods, and Vast.ai on-demand GPU rentals.

## Getting started

Requires Bun 1.3.13 or newer.

```sh
bun install
bun run dev --help

# Choose a provider and enter an API key to verify and save the account.
bun run dev auth login

# Select a provider directly.
bun run dev auth login --provider runpod
bun run dev auth login --provider vast

# An explicit alias is also supported.
bun run dev auth login work

bun run dev auth list
# Choose an account interactively if no account or default is selected.
bun run dev instance list
bun run dev --account work instance list
bun run dev --json instance list --all
bun run dev --account 'vultr:you@example.com' auth get
bun run dev --json auth get --all
```

Commands follow `<scope> <verb> [resource]`. Run a scope without a verb, such as `bun run dev provider`, to see its usage and available subcommands. Usage is written to stdout and exits successfully.

| Scope | Commands |
| --- | --- |
| `auth` | `login`, `add`, `list`, `get`, `use`, `remove` |
| `provider` | `list` |
| `instance` | `list`, `get`, `create` (`buy`), `edit`, `start`, `stop`, `reboot`, `destroy` |
| `spec` | `list machine`, `list region`, `list plan`, `list image`, `list offer` |
| `credential` | `list ssh-key` |

Provider specifications are read-only remote resources. SSH keys belong to the `credential` scope. `credential list ssh-key` lists keys already registered with the selected provider.

API keys are entered with a masked prompt. Local account configuration stores them as plaintext with owner-only file permissions (`0600`). Account listings redact stored secrets. The configuration contains credentials, so keep it out of version control.

`auth login` uses [Clack](https://bomb.sh/docs/clack/packages/prompts/) for provider selection, masked credential entry, verification progress, and a success summary. When an ID is omitted, it queries provider metadata and saves the account as `provider:email`, for example `vultr:you@example.com`. The email comes from the verified provider response. Credentials must also have permission to list instances.

When `--provider` is omitted, `auth login` uses an existing account's provider or the prefix of a `provider:email` ID. Otherwise, interactive `auth login` offers a provider picker, including when credentials are supplied through `--credential` environment references. Use `--provider` to select directly. JSON mode, `--credentials-stdin`, and noninteractive `auth login` skip the picker and default to Vultr when the provider cannot be inferred.

`auth login NAME` preserves explicit aliases such as `work` and verifies them with a read-only instance listing. An explicit `provider:email` ID must match the verified email. Logging into the same ID refreshes its credentials while preserving the default selection and other accounts. Existing aliases are retained. Failed verification or cancellation before saving leaves the configuration unchanged. Login reports the instance count without printing inventory or credentials.

`auth add NAME` offers the same provider picker for offline registration without verification. An explicit `--provider` or a `provider:email` prefix skips the picker. JSON mode, `--credentials-stdin`, and noninteractive account registration require `--provider` when it cannot be inferred from the ID. Both login and account registration support `--credentials-stdin` and `--credential` environment references.

Account selection follows `--account`, then `VPS_CTL_ACCOUNT`, then the saved default. If none is set, interactive commands offer an account picker for that invocation. Use `auth use ID` to save a default. Adding an account or choosing one in the picker does not set the default. Noninteractive commands and `--json` require an explicit, environment, or saved selection. `--all` (also accepted as `--all-accounts`) bypasses the picker and cannot be combined with `--account` or `VPS_CTL_ACCOUNT`; a failure in one account preserves the other results and returns exit code 1.

When a provider has exactly one configured account, its ID (`vultr`, `runpod`, or `vast`) is an account shortcut. Use it with `--account` / `-a`, `VPS_CTL_ACCOUNT`, `auth use`, `auth remove`, or `auth login` to refresh that existing account. Exact account IDs take precedence over shortcuts; if several accounts share a provider, select a full ID or explicit alias. A shortcut is not displayed when it would collide with another account's exact ID.

Account listings, pickers, headers, login summaries, and human-readable mutation previews show the provider shortcut when it is unambiguous. Configuration and JSON keep the original IDs, including `provider:email` IDs and explicit aliases; saving a default through a shortcut stores the full ID. New account IDs supplied to `auth add` remain literal.

```sh
bun run dev -a vast instance list
bun run dev --account vultr spec list machine
bun run dev auth use runpod
# Refresh the unique existing account for Vultr.
bun run dev auth login vultr
```

The previous root `login`, `account`, and `catalog` commands have moved to these scopes. Update scripts to use `auth login`, the corresponding `auth` verb (`auth get` replaces account metadata lookup), and `spec list <resource>`. JSON action names follow the same structure: `auth.login`, `auth.list`, `auth.get`, `spec.list.region`, and `credential.list.ssh_key`, for example. Provider and instance action names are unchanged.

Prompts and guided status messages go to stderr, leaving stdout available for command results. JSON output has no guided decorations or selection prompts. Cancelling a prompt or login verification exits with code 130.

List tables adapt to the current stdout terminal width. On smaller terminals they keep identity, status, availability, and price columns first, hide lower-priority fields, and list the hidden field names below the table. Long cell values end with `…`; Unicode labels align by displayed width. Redirected output and outputs without a known terminal width retain every column. Use `--json` for complete field values.

## Authentication and account metadata

`auth get` queries live provider metadata for the selected account. `auth get --all` queries every configured account independently and retains successful results if another account fails. `auth list` remains a local configuration listing without network requests.

For Vultr, metadata includes name, email, balance, pending charges, last payment date and amount, USD currency, and account permissions (`acls`). Amounts retain the signed values reported by Vultr, without rounding or calculating an available balance. JSON output retains the full normalized record and associates each result with its local account ID. Metadata is fetched on demand and is not saved into the account configuration. Providers that lack this capability report `unsupported_operation`.

RunPod and Vast.ai expose their account email and credit balance. RunPod also reports current hourly spending when available. Fields a provider does not report, such as pending charges or last payment, are omitted. RunPod uses REST v2 for Pods and a read-only GraphQL query for account metadata; its REST API has no equivalent email/balance route. Keys must permit both metadata and inventory access for automatic account IDs.

`instance list --all` and `auth get --all` work across providers and retain successful results if another account fails. Inventory exposes only normalized fields, excluding environment variables, passwords, private keys, and other raw provider response data.

Instance listings show prices with their currency in each cost cell: `$ 6` for USD, `¥ 6` for CNY, and `6 EUR` for other currency codes. Human-readable tables have no separate currency column. JSON retains numeric `monthly_cost`/`hourly_cost` values and the `currency` field. Vultr listings request the plan catalog once and match each instance to its current advertised monthly plan rate in USD; this is a base rate, excluding add-ons, usage charges, credits, and account-specific discounts. If pricing is unavailable or a plan is no longer listed, inventory still succeeds and the price is omitted. Authentication does not request plan pricing. Hourly GPU prices remain hourly; the CLI does not estimate monthly prices from them.

## Discover machines to rent

```sh
# Query the selected account, or compare all configured accounts.
bun run dev spec list machine
bun run dev spec list machine --all
bun run dev --json spec list machine --all --type gpu --limit 10

# Categories: shared-cpu, dedicated-cpu, bare-metal, gpu.
bun run dev spec list machine --type shared-cpu
bun run dev spec list machine --type dedicated-cpu
bun run dev spec list machine --type bare-metal

# Vultr requires a region for a live stock check.
bun run dev spec list machine --region REGION_ID --available

# GPU filters use exact model names and a requested GPU count.
bun run dev spec list machine --type gpu --gpu 'Example GPU' --gpu-count 2
```

`spec list machine` discovers rental plans and offers; `instance list` lists resources already owned. Machine results include `type`, `source` (`plan` or `offer`), `availability` (`available`, `unavailable`, or `unknown`), hardware details when reported, regions, and advertised prices. JSON categories use `shared_cpu`, `dedicated_cpu`, `bare_metal`, and `gpu`. Dedicated CPU means a virtual machine with dedicated CPU resources; bare metal is a separate physical-server product.

Vultr categories follow the explicit API plan type; unrecognized types are omitted until their classification is established.

| Provider | Categories exposed | Availability |
| --- | --- | --- |
| Vultr | Shared CPU, dedicated CPU, bare metal, GPU | Catalog stock is unknown without `--region`; regional discovery checks current stock and includes supported but sold-out plans. |
| RunPod | Secure Cloud GPU Pods | Provider-reported stock for the requested GPU count, globally or in `--region`. CPU tenancy is not identified by the catalog, so CPU plans are omitted. |
| Vast.ai | Verified, rentable, unrented on-demand GPU offers | Offers matching the live search are marked available. No fixed region catalog; a `--region` filter returns no matches. |

`--available` excludes both unavailable and unknown capacity; Vultr requires `--region` with this flag. Region IDs belong to each provider, so a region filter across `--all` only matches providers that recognize that ID. Unsupported categories return no matches. `--all` retains successful account results when another fails and returns exit code 1; its JSON data contains account records with `machines` or `error`. Selected-account JSON data is the machine array, with action `spec.list.machine` in both modes.

`--disk-gb` filters reported disk capacity; Vast.ai also uses it as the requested allocation when pricing an offer. Results with unknown disk capacity are excluded when this filter is set, including RunPod GPU plans whose disk is configured during creation. Bare-metal disk configurations retain `disk_size_gb` and `disk_count`; `disk_gb` is omitted when usable total capacity cannot be established. GPU model and count filters require GPU results; unreported specifications are never inferred. Vultr GPU plans omit GPU count because the catalog does not report it. `--limit` caps results per account (1–100); catalogs are otherwise untruncated, while Vast.ai defaults to 20 offers.

Stock can change before creation. Plan IDs and offer IDs are rental specifications, not instance IDs. Monthly prices are reported only when the provider supplies them; RunPod shows the total hourly GPU price for the requested count, excluding storage and other charges. Discovery does not add bare-metal or CPU Pod provisioning to `instance create`.

Discovery references: [Vultr plan schemas](https://github.com/vultr/govultr/blob/master/plan.go), [Vultr regional availability](https://github.com/vultr/govultr/blob/master/region.go), [RunPod GPU catalog](https://docs.runpod.io/api-reference-v2/catalog/list-gpu-types), [RunPod CPU catalog](https://docs.runpod.io/api-reference-v2/catalog/list-cpu-types), [Vast.ai offer search](https://docs.vast.ai/api-reference/search/search-offers).

## Discover and manage instances

```sh
bun run dev spec list region
bun run dev spec list plan --region nrt
bun run dev spec list image
bun run dev credential list ssh-key

# Replace REGION_ID, PLAN_ID, OS_ID, and SSH_KEY_ID with specification and credential results.
bun run dev --account work instance create \
  --region REGION_ID --plan PLAN_ID --image OS_ID \
  --label web-1 --hostname web-1 --ssh-key SSH_KEY_ID \
  --tag web --enable-ipv6 --dry-run

# Run the same command without --dry-run to review and confirm interactively.
# "buy" is an alias for "create".
bun run dev --account work instance get INSTANCE_ID
bun run dev --account work instance start INSTANCE_ID
bun run dev --account work instance stop INSTANCE_ID
bun run dev --account work instance reboot INSTANCE_ID

bun run dev --account work instance edit INSTANCE_ID --label web-2
bun run dev --account work instance edit INSTANCE_ID --tag web --tag production
bun run dev --account work instance edit INSTANCE_ID --clear-tags
bun run dev --account work instance edit INSTANCE_ID --plan NEW_PLAN_ID
bun run dev --account work instance destroy INSTANCE_ID --dry-run
```

Every instance mutation supports `--dry-run` and `--yes`. Previews show the account, operation, input, and relevant effects without loading credentials or contacting the provider. They do not validate live capacity or provider-side restrictions. Interactive changes require confirmation; scripts must pass `--yes`. Operations return once the API accepts them; use `instance get` to inspect subsequent progress.

Editing sends only supplied fields. Tags replace the complete tag list; `--clear-tags` sends an empty list. Hostname is create-only because changing it can cause a Vultr OS reinstall. Vultr plan changes are subject to upgrade restrictions and can affect billing and availability. Plan region filters show supported locations rather than guaranteed current capacity.

Stopping a Vultr instance continues billing. Starting an already running instance may restart it. Destroy permanently deletes the instance and its local data and releases its IP address. Requests are never retried automatically; after a timeout or ambiguous mutation failure, verify the account's inventory before trying again.

This version provisions Vultr OS images through the instances API. Bare-metal provisioning, Kubernetes, snapshots, rebuilds, marketplace applications, attached storage, and billing management are outside the initial scope. Instance deletion does not manage separately provisioned resources.

## GPU providers

The GPU providers run containers. Pass a Docker image reference to `--image`; Vultr continues to use an OS catalog ID. Creation validates required and unsupported fields for the selected provider before confirmation, including `--dry-run`. These checks do not reserve capacity or verify live offer availability.

RunPod uses a GPU type from `spec list plan`. The initial adapter creates on-demand GPU Pods in Secure Cloud. Specify a label and container disk size; GPU count defaults to one and local persistent volume size defaults to zero; a nonzero volume must be at least 10 GB. An optional region passes the selected data center as a placement preference. GPU prices are hourly and do not include storage or other charges.

```sh
bun run dev --account runpod-account spec list region
bun run dev --account runpod-account spec list plan

# Replace GPU_TYPE_ID and DOCKER_IMAGE with your chosen GPU type and image.
bun run dev --account runpod-account instance create \
  --plan GPU_TYPE_ID --image DOCKER_IMAGE --label gpu-job \
  --gpu-count 1 --disk-gb 40 --volume-gb 20 \
  --ssh --port 22/tcp --dry-run
```

RunPod supports label edits and direct start, stop, restart, and delete actions. Stopping or restarting resets the container disk; retain important data on the volume disk or external storage. Stopping releases GPU capacity, so starting later depends on availability. Retained storage continues billing. Destroy deletes local Pod storage; separately managed network volumes are unaffected. Serverless endpoints, CPU Pods, cluster management, spot bidding, templates, network volume management, and GPU resizing are outside this adapter's scope. `spec list image` and `credential list ssh-key` report unsupported operations: use a Docker image and configure account-level SSH keys with RunPod.

Vast.ai creates instances from a specific marketplace offer. Search verified, rentable on-demand offers, then supply an offer ID, Docker image, and disk size. Search results are a point-in-time view and may be unavailable when rented. The adapter uses SSH mode and cancels creation when the offer is unavailable.

```sh
bun run dev --account vast-account spec list offer \
  --gpu 'RTX 4090' --gpu-count 1 --disk-gb 40 --limit 10

# Replace OFFER_ID and DOCKER_IMAGE with the selected offer and image.
bun run dev --account vast-account instance create \
  --offer OFFER_ID --image DOCKER_IMAGE --disk-gb 40 \
  --label gpu-job --dry-run
```

Vast.ai supports label edits, start, stop, reboot, and destroy. Stopped storage remains billable; starting may wait for GPU availability. Destroy deletes instance data. Offer prices are hourly estimates for the searched disk allocation; bandwidth and other charges may apply. Regions, fixed plans, OS catalogs, selectable SSH key IDs, tags, and plan changes are unsupported. Configure account SSH keys with Vast.ai before creating SSH instances. Spot bids, reserved contracts, host management, and serverless are outside this adapter's scope.

Creation and label edits can return `status: accepted` with an instance ID when the provider does not return full details. Use `instance get ID` to inspect provisioning progress. A successful write is not followed by an automatic read or retry.

API references: [RunPod REST v2](https://docs.runpod.io/api-reference-v2/overview), [RunPod GraphQL](https://docs.runpod.io/sdks/graphql/manage-pods), [RunPod Pod storage](https://docs.runpod.io/pods/storage/types), [Vast.ai REST API](https://vast.ai/developers/api), [Vast.ai instance API](https://docs.vast.ai/api-reference/instances/create-instance), [Vast.ai pricing](https://docs.vast.ai/guides/instances/pricing). The Vast.ai adapter follows the official [paginated inventory schema](https://github.com/vast-ai/docs/blob/main/api-reference/openapi/yaml/show_instances.yaml) at `/api/v1/instances/`; individual instance operations use `/api/v0/`.

## Account configuration

The default path is `$XDG_CONFIG_HOME/vps-ctl/config.json`, falling back to `~/.config/vps-ctl/config.json`. Override it with `VPS_CTL_CONFIG` or `--config`. The CLI uses atomic writes and rejects concurrent configuration writers.

```json
{
  "version": 1,
  "default_account_id": "vultr:you@example.com",
  "accounts": [
    {
      "id": "vultr:you@example.com",
      "provider_id": "vultr",
      "credentials": {
        "api_key": {
          "source": "literal",
          "value": "YOUR_API_KEY"
        }
      }
    }
  ]
}
```

For scripts, `auth login --provider vultr --credentials-stdin` reads a JSON object such as `{"api_key":"YOUR_API_KEY"}` from stdin, verifies access, and derives the ID from the email. Add an explicit ID to retain a custom alias. Use `auth add NAME --provider vultr --credentials-stdin` for offline registration. Credential values are not accepted as command-line flags.

Environment variable references are also available:

```sh
bun run dev auth login ci --credential api_key=VULTR_CI_API_KEY
bun run dev auth remove ci
```

An environment reference is stored as `{"source":"env","name":"VULTR_CI_API_KEY"}`. Resolve it through your shell environment or a local `.env` file. Removing a local account leaves its VPS resources intact.

## Login troubleshooting

If the error says **Unauthorized IP address**, add the exact address reported by Vultr to **API Access Control** for that user or account, then run `bun run dev auth login` again. The CLI recognizes this restriction in HTTP `401` or `403` responses and classifies it as `forbidden`. Use a single-host entry (`/32` for IPv4 or `/128` for IPv6). A terminal using a VPN or proxy may have a different outbound address from your browser, so use the address Vultr reports for the failed request.

For other HTTP `401` errors, check the provider's error detail. Paste the complete API key value, rather than its name, ID, or masked display value, without quotes or a `Bearer` prefix. For a newly generated IAM key, complete **Finalize Key Generation** in the Vultr Console after copying it. Confirm the key is still active and has not expired. Failed login attempts do not save the rejected key.

HTTP errors include Vultr's JSON `error` message when available, with the supplied API key and Bearer credentials redacted. Other response fields and non-JSON bodies are omitted. Use that detail to distinguish credential rejection from permission or access-control failures.

For HTTP `403`, check that API access is enabled, the user has permission to list instances, and the API access-control list allows your machine's current outbound IP address. Keep IP restrictions limited to the hosts that need access.

See Vultr's [API key creation guide](https://docs.vultr.com/platform/iam/organizations/manage-user-api-access/how-to-create-an-api-key-for-a-user) and [user API access controls](https://docs.vultr.com/support/platform/users/how-can-i-manage-api-access-for-users).

## Development

```sh
bun run check   # Type checking, Biome, and the Bun test suite
bun run format
bun run build
./dist/vps-ctl --help
```

Tests use temporary account configurations and injected provider transports. They do not require API credentials or create resources.

```text
src/
  cli.ts                 Executable entry point
  commands/              Auth, provider, instance, spec, and credential commands; terminal IO
  core/accounts.ts       Account persistence and credential resolution
  core/provider.ts       Provider contract and normalized records
  core/machines.ts       Shared rental discovery filters and validation
  core/registry.ts       Built-in adapter registration and credential routing
  providers/http.ts      Shared bearer HTTP transport for GPU providers
  providers/vultr/       Vultr API transport, validation, and mapping
  providers/runpod/      RunPod REST v2 Pods and GraphQL account metadata
  providers/vast/        Vast.ai marketplace and instance management
tests/                   Account, CLI, and adapter tests
```

Accounts and commands depend on the provider contract. Adapters can use HTTP, an SDK, or an existing CLI internally. To add a provider, implement `Provider`, supply a `ProviderDefinition` with offline instance-ID and create/edit validation, and register it in `core/registry.ts`. Unsupported operations must return `unsupported_operation`; unavailable metadata and pricing fields are omitted. The current registry is static; external plugin discovery, installation, and versioning remain deferred while these built-in adapters establish the shared contract.

References: [Bun executables](https://bun.sh/docs/bundler/executables), [Vultr's official API client](https://github.com/vultr/govultr), [Vultr account metadata](https://github.com/vultr/govultr/blob/master/account.go), [Vultr instance behavior](https://docs.vultr.com/reference/terraform/resources/instance), [Vultr stopped-instance billing](https://docs.vultr.com/support/platform/billing/are-stopped-instances-still-billed-on-vultr).
