# vps-ctl

A Bun + TypeScript CLI for managing compute instances across multiple local accounts: Vultr Cloud Compute, RunPod GPU Pods, and Vast.ai on-demand GPU rentals.

## Getting started

Requires Bun 1.3.13 or newer.

```sh
bun install
bun run dev --help

# Choose a provider and enter an API key to verify and save the account.
bun run dev login

# Select a provider directly.
bun run dev login --provider runpod
bun run dev login --provider vast

# An explicit alias is also supported.
bun run dev login work

bun run dev account list
# Choose an account interactively if no account or default is selected.
bun run dev instance list
bun run dev --account work instance list
bun run dev --json instance list --all-accounts
bun run dev --account 'vultr:you@example.com' account info
bun run dev --json account info --all-accounts
```

API keys are entered with a masked prompt. Local account configuration stores them as plaintext with owner-only file permissions (`0600`). Account listings redact stored secrets. The configuration contains credentials, so keep it out of version control.

`login` uses [Clack](https://bomb.sh/docs/clack/packages/prompts/) for provider selection, masked credential entry, verification progress, and a success summary. When an ID is omitted, it queries provider metadata and saves the account as `provider:email`, for example `vultr:you@example.com`. The email comes from the verified provider response. Credentials must also have permission to list instances. Use `--provider vultr` to skip provider selection; noninteractive login defaults to Vultr.

`login NAME` preserves explicit aliases such as `work` and verifies them with a read-only instance listing. An explicit `provider:email` ID must match the verified email. Logging into the same ID refreshes its credentials while preserving the default selection and other accounts. Existing aliases are retained. Failed verification or cancellation before saving leaves the configuration unchanged. Login reports the instance count without printing inventory or credentials.

`account add NAME --provider vultr` remains available for offline registration without verification. Both commands support `--credentials-stdin` and `--credential` environment references.

Account selection follows `--account`, then `VPS_CTL_ACCOUNT`, then the saved default. If none is set, interactive commands offer an account picker for that invocation. Use `account use ID` to save a default. Adding an account or choosing one in the picker does not set the default. Noninteractive commands and `--json` require an explicit, environment, or saved selection. `--all-accounts` bypasses the picker and cannot be combined with `--account` or `VPS_CTL_ACCOUNT`; a failure in one account preserves the other results and returns exit code 1.

Prompts and guided status messages go to stderr, leaving stdout available for command results. JSON output has no guided decorations or selection prompts. Cancelling a prompt or login verification exits with code 130.

## Account metadata

`account info` queries live provider metadata for the selected account. `account info --all-accounts` queries every configured account independently and retains successful results if another account fails. `account list` remains a local configuration listing without network requests.

For Vultr, metadata includes name, email, balance, pending charges, last payment date and amount, USD currency, and account permissions (`acls`). Amounts retain the signed values reported by Vultr, without rounding or calculating an available balance. JSON output retains the full normalized record and associates each result with its local account ID. Metadata is fetched on demand and is not saved into the account configuration. Providers that lack this capability report `unsupported_operation`.

RunPod and Vast.ai expose their account email and credit balance. RunPod also reports current hourly spending when available. Fields a provider does not report, such as pending charges or last payment, are omitted. RunPod uses REST v2 for Pods and a read-only GraphQL query for account metadata; its REST API has no equivalent email/balance route. Keys must permit both metadata and inventory access for automatic account IDs.

`instance list --all-accounts` and `account info --all-accounts` work across providers and retain successful results if another account fails. Inventory exposes only normalized fields, excluding environment variables, passwords, private keys, and other raw provider response data.

## Discover and manage instances

```sh
bun run dev catalog regions
bun run dev catalog plans --region nrt
bun run dev catalog images
bun run dev catalog ssh-keys

# Replace REGION_ID, PLAN_ID, OS_ID, and SSH_KEY_ID with catalog results.
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

This version provisions Vultr OS images through the instances API. Bare Metal, Kubernetes, snapshots, rebuilds, marketplace applications, attached storage, and billing management are outside the initial scope. Instance deletion does not manage separately provisioned resources.

## GPU providers

The GPU providers run containers. Pass a Docker image reference to `--image`; Vultr continues to use an OS catalog ID. Creation validates required and unsupported fields for the selected provider before confirmation, including `--dry-run`. These checks do not reserve capacity or verify live offer availability.

RunPod uses a GPU type from `catalog plans`. The initial adapter creates on-demand GPU Pods in Secure Cloud. Specify a label and container disk size; GPU count defaults to one and local persistent volume size defaults to zero; a nonzero volume must be at least 10 GB. An optional region passes the selected data center as a placement preference. GPU prices are hourly and do not include storage or other charges.

```sh
bun run dev --account runpod-account catalog regions
bun run dev --account runpod-account catalog plans

# Replace GPU_TYPE_ID and DOCKER_IMAGE with your chosen GPU type and image.
bun run dev --account runpod-account instance create \
  --plan GPU_TYPE_ID --image DOCKER_IMAGE --label gpu-job \
  --gpu-count 1 --disk-gb 40 --volume-gb 20 \
  --ssh --port 22/tcp --dry-run
```

RunPod supports label edits and direct start, stop, restart, and delete actions. Stopping or restarting resets the container disk; retain important data on the volume disk or external storage. Stopping releases GPU capacity, so starting later depends on availability. Retained storage continues billing. Destroy deletes local Pod storage; separately managed network volumes are unaffected. Serverless endpoints, CPU Pods, cluster management, spot bidding, templates, network volume management, and GPU resizing are outside this adapter's scope. `catalog images` and `catalog ssh-keys` report unsupported operations: use a Docker image and configure account-level SSH keys with RunPod.

Vast.ai creates instances from a specific marketplace offer. Search verified, rentable on-demand offers, then supply an offer ID, Docker image, and disk size. Search results are a point-in-time view and may be unavailable when rented. The adapter uses SSH mode and cancels creation when the offer is unavailable.

```sh
bun run dev --account vast-account catalog offers \
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

For scripts, `login --provider vultr --credentials-stdin` reads a JSON object such as `{"api_key":"YOUR_API_KEY"}` from stdin, verifies access, and derives the ID from the email. Add an explicit ID to retain a custom alias. Use `account add NAME --provider vultr --credentials-stdin` for offline registration. Credential values are not accepted as command-line flags.

Environment variable references are also available:

```sh
bun run dev login ci --credential api_key=VULTR_CI_API_KEY
bun run dev account remove ci
```

An environment reference is stored as `{"source":"env","name":"VULTR_CI_API_KEY"}`. Resolve it through your shell environment or a local `.env` file. Removing a local account leaves its VPS resources intact.

## Login troubleshooting

If the error says **Unauthorized IP address**, add the exact address reported by Vultr to **API Access Control** for that user or account, then run `bun run dev login` again. The CLI recognizes this restriction in HTTP `401` or `403` responses and classifies it as `forbidden`. Use a single-host entry (`/32` for IPv4 or `/128` for IPv6). A terminal using a VPN or proxy may have a different outbound address from your browser, so use the address Vultr reports for the failed request.

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
  commands/              Account, catalog, and instance commands; terminal IO
  core/accounts.ts       Account persistence and credential resolution
  core/provider.ts       Provider contract and normalized records
  core/registry.ts       Built-in adapter registration and credential routing
  providers/http.ts      Shared bearer HTTP transport for GPU providers
  providers/vultr/       Vultr API transport, validation, and mapping
  providers/runpod/      RunPod REST v2 Pods and GraphQL account metadata
  providers/vast/        Vast.ai marketplace and instance management
tests/                   Account, CLI, and adapter tests
```

Accounts and commands depend on the provider contract. Adapters can use HTTP, an SDK, or an existing CLI internally. To add a provider, implement `Provider`, supply a `ProviderDefinition` with offline instance-ID and create/edit validation, and register it in `core/registry.ts`. Unsupported operations must return `unsupported_operation`; unavailable metadata and pricing fields are omitted. The current registry is static; external plugin discovery, installation, and versioning remain deferred while these built-in adapters establish the shared contract.

References: [Bun executables](https://bun.sh/docs/bundler/executables), [Vultr's official API client](https://github.com/vultr/govultr), [Vultr account metadata](https://github.com/vultr/govultr/blob/master/account.go), [Vultr instance behavior](https://docs.vultr.com/reference/terraform/resources/instance), [Vultr stopped-instance billing](https://docs.vultr.com/support/platform/billing/are-stopped-instances-still-billed-on-vultr).
