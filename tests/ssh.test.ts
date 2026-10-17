import { describe, expect, test } from "bun:test";
import type { Instance } from "../src/core/provider.ts";
import { resolveSshConnection, validateSshUser } from "../src/core/ssh.ts";

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    provider_id: "vultr",
    id: "example-instance",
    label: "Example instance",
    region_id: "example-region",
    plan_id: "example-plan",
    image_id: "101",
    status: "running",
    provider_status: "active",
    power_status: "running",
    server_status: "ok",
    public_ipv4: "192.0.2.10",
    public_ipv6: "2001:db8::10",
    tags: [],
    ...overrides,
  };
}

describe("SSH connection resolution", () => {
  test("uses the Vultr public address without guessing an OS username", () => {
    expect(resolveSshConnection(instance())).toEqual({
      host: "192.0.2.10",
      port: 22,
      method: "direct",
    });
    expect(resolveSshConnection(instance({ public_ipv4: "" }))).toEqual({
      host: "2001:db8::10",
      port: 22,
      method: "direct",
    });
  });

  test("prefers the published endpoint and lets explicit connection options win", () => {
    expect(
      resolveSshConnection(
        instance({
          ssh_host: "ssh.example.invalid",
          ssh_port: 22022,
          ssh_user: "provider-user",
        }),
        { user: "example-user", port: 2222 },
      ),
    ).toEqual({
      host: "ssh.example.invalid",
      port: 2222,
      user: "example-user",
      method: "direct",
    });
  });

  test("uses the exact RunPod proxy username instead of deriving it from the ID", () => {
    expect(
      resolveSshConnection(
        instance({
          provider_id: "runpod",
          ssh_host: "ssh.runpod.io",
          ssh_port: 22,
          ssh_user: "pod-example-routing-token",
          ssh_method: "proxy",
        }),
      ),
    ).toEqual({
      host: "ssh.runpod.io",
      port: 22,
      user: "pod-example-routing-token",
      method: "proxy",
    });
  });

  test("requires the RunPod proxy routing username", () => {
    const pod = instance({
      provider_id: "runpod",
      ssh_host: "ssh.runpod.io",
      ssh_port: 22,
      ssh_method: "proxy",
    });
    expect(() => resolveSshConnection(pod)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(
      resolveSshConnection(pod, { user: "example-routing-token" }).user,
    ).toBe("example-routing-token");
  });

  test("retains an absent direct RunPod username for the caller to resolve", () => {
    expect(
      resolveSshConnection(
        instance({
          provider_id: "runpod",
          ssh_host: "192.0.2.11",
          ssh_port: 22022,
          ssh_method: "direct",
        }),
      ).user,
    ).toBeUndefined();
  });

  test("uses the documented root user for Vast endpoints", () => {
    const rental = instance({
      provider_id: "vast",
      ssh_host: "ssh.example.invalid",
      ssh_port: 22022,
      ssh_method: "proxy",
    });
    expect(resolveSshConnection(rental)).toEqual({
      host: "ssh.example.invalid",
      port: 22022,
      user: "root",
      method: "proxy",
    });
    expect(resolveSshConnection(rental, { user: "custom-user" }).user).toBe(
      "custom-user",
    );
  });

  test.each(["runpod", "vast", "example-provider"])(
    "does not invent an SSH endpoint from a public IP for %s",
    (provider_id) => {
      expect(() => resolveSshConnection(instance({ provider_id }))).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    },
  );

  test.each(["stopped", "pending", "unknown"] as const)(
    "rejects %s instances even if a published endpoint remains",
    (status) => {
      expect(() =>
        resolveSshConnection(
          instance({ status, ssh_host: "192.0.2.10", ssh_port: 22022 }),
        ),
      ).toThrow(expect.objectContaining({ code: "conflict" }));
    },
  );

  test("does not treat a public address field as a DNS hostname", () => {
    expect(() =>
      resolveSshConnection(
        instance({ public_ipv4: "ssh.example.invalid", public_ipv6: "" }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test.each([
    "192.0.2.10",
    "2001:db8::10",
    "ssh.example.invalid",
    "ssh.example.invalid.",
    "example-host",
  ])("accepts an SSH hostname or literal address %s", (ssh_host) => {
    expect(
      resolveSshConnection(instance({ ssh_host, ssh_port: 22 })).host,
    ).toBe(ssh_host);
  });

  test.each([
    "",
    "-oProxyCommand=example",
    "example-user@ssh.example.invalid",
    "ssh.example.invalid:22",
    "ssh://ssh.example.invalid",
    "ssh.example.invalid/command",
    "ssh.example.invalid\n",
    "ssh.example.invalid\u001b[2J",
    "$(example)",
    "`example`",
    "example;command",
    "example host",
    "[2001:db8::10]",
    "fe80::1%eth0",
    "double..example.invalid",
    `${"a".repeat(64)}.example.invalid`,
  ])("rejects unsafe or malformed SSH hostname %j", (ssh_host) => {
    expect(() =>
      resolveSshConnection(instance({ ssh_host, ssh_port: 22 })),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test.each([0, -1, 65536, 22.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid SSH port %s",
    (port) => {
      expect(() => resolveSshConnection(instance(), { port })).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    },
  );

  test.each([1, 65535])("accepts SSH port boundary %s", (port) => {
    expect(resolveSshConnection(instance(), { port }).port).toBe(port);
  });

  test.each([
    "",
    "-example",
    "example user",
    "example\n",
    "example\u001b[2J",
    "example@host",
    "example;command",
    "$(example)",
    "example/command",
    "a".repeat(257),
  ])("rejects unsafe SSH username %j", (user) => {
    expect(() => resolveSshConnection(instance(), { user })).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  test.each(["root", "example-user", "pod-example_token", "machine$"])(
    "validates a safe username %s",
    (user) => {
      expect(validateSshUser(user)).toBe(user);
    },
  );
});
