# vps-ctl

A Bun + TypeScript CLI for managing VPS instances across multiple named accounts. Vultr Cloud Compute is the first provider.

## Getting started

Requires Bun 1.3.13 or newer.

```sh
bun install
bun run dev --help

# Prompts for an API key, verifies instance access, then saves the account.
bun run dev login personal
bun run dev login work
bun run dev account use personal

bun run dev account list
bun run dev instance list
bun run dev --account work instance list
bun run dev --json instance list --all-accounts
```

API keys are entered with a masked prompt. Local account configuration stores them as plaintext with owner-only file permissions (`0600`). Account listings redact stored secrets. The configuration contains credentials, so keep it out of version control.

`login NAME` verifies credentials with a read-only instance listing before saving them. Run `login` without a name to enter it interactively. New accounts default to Vultr; use `--provider` to select another registered provider. Logging into an existing name refreshes its credentials while preserving the default selection and other accounts. Failed verification leaves the saved configuration unchanged. Login reports the instance count without printing inventory or credentials.

`account add NAME --provider vultr` remains available for offline registration without verification. Both commands support `--credentials-stdin` and `--credential` environment references.

Account selection follows `--account`, then `VPS_CTL_ACCOUNT`, then the saved default. Adding an account does not implicitly set the default. `--all-accounts` requires neither `--account` nor `VPS_CTL_ACCOUNT`; a failure in one account preserves the other results and returns exit code 1.

## Discover and manage instances

```sh
bun run dev catalog regions
bun run dev catalog plans --region nrt
bun run dev catalog images
bun run dev catalog ssh-keys

# Replace REGION_ID, PLAN_ID, OS_ID, and SSH_KEY_ID with catalog results.
bun run dev --account personal instance create \
  --region REGION_ID --plan PLAN_ID --image OS_ID \
  --label web-1 --hostname web-1 --ssh-key SSH_KEY_ID \
  --tag web --enable-ipv6 --dry-run

# Run the same command without --dry-run to review and confirm interactively.
# "buy" is an alias for "create".
bun run dev --account personal instance get INSTANCE_ID
bun run dev --account personal instance start INSTANCE_ID
bun run dev --account personal instance stop INSTANCE_ID
bun run dev --account personal instance reboot INSTANCE_ID

bun run dev --account personal instance edit INSTANCE_ID --label web-2
bun run dev --account personal instance edit INSTANCE_ID --tag web --tag production
bun run dev --account personal instance edit INSTANCE_ID --clear-tags
bun run dev --account personal instance edit INSTANCE_ID --plan NEW_PLAN_ID
bun run dev --account personal instance destroy INSTANCE_ID --dry-run
```

Every instance mutation supports `--dry-run` and `--yes`. Previews show the account, operation, input, and relevant effects without loading credentials or contacting the provider. They do not validate live capacity or provider-side restrictions. Interactive changes require confirmation; scripts must pass `--yes`. Operations return once the API accepts them; use `instance get` to inspect subsequent progress.

Editing sends only supplied fields. Tags replace the complete tag list; `--clear-tags` sends an empty list. Hostname is create-only because changing it can cause a Vultr OS reinstall. Vultr plan changes are subject to upgrade restrictions and can affect billing and availability. Plan region filters show supported locations rather than guaranteed current capacity.

Stopping a Vultr instance continues billing. Starting an already running instance may restart it. Destroy permanently deletes the instance and its local data and releases its IP address. Requests are never retried automatically; after a timeout or ambiguous mutation failure, verify the account's inventory before trying again.

This version provisions Vultr OS images through the instances API. Bare Metal, Kubernetes, snapshots, rebuilds, marketplace applications, attached storage, and billing management are outside the initial scope. Instance deletion does not manage separately provisioned resources.

## Account configuration

The default path is `$XDG_CONFIG_HOME/vps-ctl/config.json`, falling back to `~/.config/vps-ctl/config.json`. Override it with `VPS_CTL_CONFIG` or `--config`. The CLI uses atomic writes and rejects concurrent configuration writers.

```json
{
  "version": 1,
  "default_account_id": "personal",
  "accounts": [
    {
      "id": "personal",
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

For scripts, `login NAME --credentials-stdin` reads a JSON object such as `{"api_key":"YOUR_API_KEY"}` from stdin and verifies it before saving. Use `account add NAME --provider vultr --credentials-stdin` for offline registration. Credential values are not accepted as command-line flags.

Environment variable references are also available:

```sh
bun run dev login ci --credential api_key=VULTR_CI_API_KEY
bun run dev account remove ci
```

An environment reference is stored as `{"source":"env","name":"VULTR_CI_API_KEY"}`. Resolve it through your shell environment or a local `.env` file. Removing a local account leaves its VPS resources intact.

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
  providers/vultr/       Vultr API transport, validation, and mapping
tests/                   Account, CLI, and adapter tests
```

Accounts and commands depend on the provider contract. Adapters can use HTTP, an SDK, or an existing CLI internally. To add a provider, implement `Provider`, supply a `ProviderDefinition`, and register it in `core/registry.ts`. The current registry is static; external plugin discovery, installation, and versioning are deferred until a second provider helps establish the shared contract.

References: [Bun executables](https://bun.sh/docs/bundler/executables), [Vultr's official API client](https://github.com/vultr/govultr), [Vultr instance behavior](https://docs.vultr.com/reference/terraform/resources/instance), [Vultr stopped-instance billing](https://docs.vultr.com/support/platform/billing/are-stopped-instances-still-billed-on-vultr).
