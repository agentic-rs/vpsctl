import { describe, expect, test } from "bun:test";
import { instancePasswordHelp } from "../src/commands/instance-password-help.ts";
import { vultr_info } from "../src/providers/vultr/index.ts";

describe("instance password help", () => {
  test("links directly to the selected Vultr instance", () => {
    expect(instancePasswordHelp(vultr_info, "instance-example")).toMatchObject({
      url: "https://console.vultr.com/subs/?id=instance-example&sub_type=instances",
    });
  });

  test("encodes the instance ID without changing the console query", () => {
    const help = instancePasswordHelp(vultr_info, "example&sub_type=other/#?%");

    expect(help?.url).toBe(
      "https://console.vultr.com/subs/?id=example%26sub_type%3Dother%2F%23%3F%25&sub_type=instances",
    );
    const url = new URL(help?.url ?? "");
    expect(url.searchParams.get("id")).toBe("example&sub_type=other/#?%");
    expect(url.searchParams.getAll("sub_type")).toEqual(["instances"]);
  });

  test("leaves providers without password help unsupported", () => {
    expect(
      instancePasswordHelp(
        { id: "example", name: "Example provider", capabilities: [] },
        "instance-example",
      ),
    ).toBeUndefined();
  });
});
