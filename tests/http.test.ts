import { describe, expect, spyOn, test } from "bun:test";
import { AppError, type ErrorCode } from "../src/core/errors.ts";
import { type HttpOptions, ProviderHttp } from "../src/providers/http.ts";

const api_key = "synthetic-api-key+reserved";
const base_url = "https://api.example.invalid/v1";

function harness(responses: Response[] = []): {
  client: ProviderHttp;
  requests: Request[];
} {
  const requests: Request[] = [];
  return {
    requests,
    client: new ProviderHttp("Example", base_url, {
      api_key,
      fetch: async (request) => {
        requests.push(request);
        const response = responses.shift();
        if (!response) throw new Error(`Unexpected request with ${api_key}.`);
        return response;
      },
    }),
  };
}

async function errorFrom(operation: Promise<unknown>): Promise<AppError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected a request error.");
}

describe("provider HTTP requests", () => {
  test("sends bearer credentials only in headers and preserves the API base", async () => {
    const { client, requests } = harness([Response.json({ resources: [] })]);
    expect(await client.request("/resources?limit=20")).toEqual({
      resources: [],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${base_url}/resources?limit=20`);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.redirect).toBe("error");
    expect(requests[0]?.headers.get("Authorization")).toBe(`Bearer ${api_key}`);
    expect(requests[0]?.headers.get("Accept")).toBe("application/json");
    expect(requests[0]?.headers.has("Content-Type")).toBe(false);
    expect(await requests[0]?.text()).toBe("");
    expect(requests[0]?.url).not.toContain(api_key);
  });

  test("serializes JSON bodies for every supported mutation method", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const { client, requests } = harness([
        Response.json({ id: "resource-1" }),
      ]);
      await client.request("/resources", {
        method,
        body: { label: "example" },
      });
      expect(requests[0]?.method).toBe(method);
      expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
      expect(await requests[0]?.json()).toEqual({ label: "example" });
    }
  });

  test("accepts intentionally empty responses without trying to parse JSON", async () => {
    const { client } = harness([new Response(null, { status: 204 })]);
    expect(
      await client.request("/resources/1", {
        method: "DELETE",
        expects_json: false,
      }),
    ).toBeUndefined();
  });

  test("allows root API bases and query values with literal percent characters", async () => {
    const requests: Request[] = [];
    const client = new ProviderHttp("Example", "https://api.example.invalid/", {
      api_key,
      fetch: async (request) => {
        requests.push(request);
        return Response.json({});
      },
    });
    const query = encodeURIComponent(
      JSON.stringify({ gpu_name: { like: "%GPU%" } }),
    );
    await client.request(`/resources?q=${query}`);
    expect(new URL(requests[0]?.url ?? "").searchParams.get("q")).toBe(
      '{"gpu_name":{"like":"%GPU%"}}',
    );
  });

  test("rejects origin changes, traversal, fragments, controls, and credential URLs before fetch", async () => {
    const { client, requests } = harness();
    const invalid_paths = [
      "https://other.example.invalid/resources",
      "//other.example.invalid/resources",
      "resources",
      "/../resources",
      "/group/../resources",
      "/%2e%2e/resources",
      "/%252e%252e/resources",
      "/group%2f..%2fresources",
      "/group\\resources",
      "/resources#hidden",
      "/resources\u0000",
      "/resources?api_key=another-secret",
      "/resources?api%255fkey=another-secret",
      "/resources?authorization=another-secret",
      `/resources?filter=${encodeURIComponent(api_key)}`,
      "/resources?filter=Bearer%20another-secret",
    ];
    for (const path of invalid_paths) {
      const error = await errorFrom(client.request(path));
      expect(error.code).toBe("invalid_input");
      expect(error.message).not.toContain(api_key);
      expect(error.message).not.toContain("another-secret");
    }
    expect(requests).toHaveLength(0);
  });

  test("rejects unsafe constructor configuration without echoing it", () => {
    for (const unsafe_base of [
      "http://api.example.invalid/v1",
      `https://user:${api_key}@api.example.invalid/v1`,
      `https://api.example.invalid/v1?api_key=${api_key}`,
      "https://api.example.invalid/v1#fragment",
      "https://api.example.invalid/v1/../v2",
    ]) {
      try {
        new ProviderHttp("Example", unsafe_base, { api_key });
        throw new Error("Expected invalid configuration.");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("invalid_input");
        expect((error as Error).message).not.toContain(api_key);
        expect((error as Error).message).not.toContain(unsafe_base);
      }
    }
    for (const invalid_key of [
      "",
      "space separated",
      "control\u0000key",
      "nonascii-\u00e9",
    ]) {
      expect(
        () => new ProviderHttp("Example", base_url, { api_key: invalid_key }),
      ).toThrow(AppError);
    }
    for (const timeout_ms of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(
        () => new ProviderHttp("Example", base_url, { api_key, timeout_ms }),
      ).toThrow(AppError);
    }
    expect(() => new ProviderHttp("Example\n", base_url, { api_key })).toThrow(
      AppError,
    );
    expect(
      () =>
        new ProviderHttp("Example", base_url, {
          api_key,
          fetch: 1,
        } as unknown as HttpOptions),
    ).toThrow(AppError);
  });

  test("safely rejects unencodable request bodies without sending them", async () => {
    const { client, requests } = harness();
    const body: Record<string, unknown> = { secret: api_key };
    body.circular = body;
    const error = await errorFrom(
      client.request("/resources", { method: "POST", body }),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).not.toContain(api_key);
    expect(requests).toHaveLength(0);
  });
});

describe("provider HTTP error handling", () => {
  test("maps response statuses to stable application error codes", async () => {
    const cases: [number, ErrorCode][] = [
      [400, "invalid_input"],
      [401, "authentication"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "conflict"],
      [422, "invalid_input"],
      [429, "rate_limit"],
      [500, "provider_error"],
    ];
    for (const [status, code] of cases) {
      const { client, requests } = harness([
        Response.json({ error: "Safe detail." }, { status }),
      ]);
      const error = await errorFrom(client.request("/resources"));
      expect(error.code).toBe(code);
      expect(error.status_code).toBe(status);
      expect(error.message).toBe(
        `Example rejected the request (HTTP ${status}). Safe detail.`,
      );
      expect(requests).toHaveLength(1);
    }
  });

  test("redacts literal keys and bearer values and strips control characters", async () => {
    const { client } = harness([
      Response.json(
        {
          error: `Denied ${api_key}; encoded=${encodeURIComponent(api_key)}; Bearer other-secret\u001b\nretry`,
          debug: "private-debug",
        },
        { status: 401 },
      ),
    ]);
    const error = await errorFrom(client.request("/resources"));
    expect(error.message).toContain("[redacted]");
    for (const secret of [
      api_key,
      encodeURIComponent(api_key),
      "other-secret",
      "private-debug",
      "\u001b",
      "\n",
    ]) {
      expect(error.message).not.toContain(secret);
    }
  });

  test("reads only known string error fields and bounds the displayed detail", async () => {
    for (const field of ["error", "message", "detail"]) {
      const { client } = harness([
        Response.json(
          { [field]: "x".repeat(1000), private: api_key },
          { status: 403 },
        ),
      ]);
      const error = await errorFrom(client.request("/resources"));
      expect(error.message.length).toBeLessThan(600);
      expect(error.message).not.toContain(api_key);
    }
    for (const body of [
      { error: { message: api_key }, debug: api_key },
      [api_key],
      null,
    ]) {
      const { client } = harness([Response.json(body, { status: 401 })]);
      expect((await errorFrom(client.request("/resources"))).message).toBe(
        "Example rejected the request (HTTP 401).",
      );
    }
  });

  test("never includes raw non-JSON error bodies or fetch failure messages", async () => {
    const { client, requests } = harness([
      new Response(`<html>${api_key}</html>`, { status: 502 }),
    ]);
    const error = await errorFrom(client.request("/resources"));
    expect(error.message).toBe("Example rejected the request (HTTP 502).");
    const network_error = await errorFrom(client.request("/resources"));
    expect(network_error.code).toBe("network_error");
    expect(network_error.message).toBe(
      "Example request failed due to a network error.",
    );
    expect(requests).toHaveLength(2);
  });

  test("advises checking state after ambiguous mutation failures without retrying", async () => {
    const { client, requests } = harness([
      Response.json({ error: "Unavailable." }, { status: 503 }),
      new Response("not-json"),
    ]);
    for (const expected_code of [
      "provider_error",
      "invalid_response",
      "network_error",
    ] as const) {
      const error = await errorFrom(
        client.request("/resources", { method: "POST", body: {} }),
      );
      expect(error.code).toBe(expected_code);
      expect(error.message).toContain(
        "verify the resource state before retrying",
      );
      expect(error.message).not.toContain(api_key);
    }
    expect(requests).toHaveLength(3);
  });

  test("does not attach mutation ambiguity advice to GraphQL read requests", async () => {
    const { client } = harness([
      Response.json({}, { status: 503 }),
      new Response("not-json"),
    ]);
    for (let count = 0; count < 3; count++) {
      const error = await errorFrom(
        client.request("/graphql", {
          method: "POST",
          mutating: false,
          body: { query: "query { myself { id } }" },
        }),
      );
      expect(error.message).not.toContain("may have succeeded");
    }
  });
});

describe("provider HTTP cancellation and timeouts", () => {
  test("does not send pre-cancelled requests or echo cancellation reasons", async () => {
    const { client, requests } = harness();
    const controller = new AbortController();
    controller.abort(new Error(api_key));
    const error = await errorFrom(
      client.request("/resources", {
        method: "POST",
        signal: controller.signal,
      }),
    );
    expect(error.code).toBe("cancelled");
    expect(error.message).toBe("Operation cancelled.");
    expect(requests).toHaveLength(0);
  });

  test("does not send a request if cancellation happens while encoding its body", async () => {
    const { client, requests } = harness();
    const controller = new AbortController();
    const error = await errorFrom(
      client.request("/resources", {
        method: "POST",
        signal: controller.signal,
        body: {
          toJSON() {
            controller.abort(api_key);
            return {};
          },
        },
      }),
    );
    expect(error.code).toBe("cancelled");
    expect(error.message).toBe("Operation cancelled.");
    expect(requests).toHaveLength(0);
  });

  test("cancels fetches that ignore abort and removes external signal listeners", async () => {
    const controller = new AbortController();
    const add_listener = spyOn(controller.signal, "addEventListener");
    const remove_listener = spyOn(controller.signal, "removeEventListener");
    let request_signal: AbortSignal | undefined;
    const client = new ProviderHttp("Example", base_url, {
      api_key,
      fetch: async (request) => {
        request_signal = request.signal;
        controller.abort(new Error(api_key));
        return new Promise<Response>(() => {});
      },
    });
    const error = await errorFrom(
      client.request("/resources", { signal: controller.signal }),
    );
    expect(error.code).toBe("cancelled");
    expect(error.message).toBe("Operation cancelled.");
    expect(request_signal?.aborted).toBe(true);
    expect(add_listener).toHaveBeenCalledTimes(1);
    expect(remove_listener).toHaveBeenCalledTimes(1);
    expect(remove_listener.mock.calls[0]?.[1]).toBe(
      add_listener.mock.calls[0]?.[1],
    );
    add_listener.mockRestore();
    remove_listener.mockRestore();
  });

  test("cancellation while parsing a successful body remains a cancellation", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ start() {} }));
    const parse = spyOn(response, "json").mockImplementation(async () => {
      controller.abort(new Error(api_key));
      return new Promise<unknown>(() => {});
    });
    const client = new ProviderHttp("Example", base_url, {
      api_key,
      fetch: async () => response,
    });
    const error = await errorFrom(
      client.request("/resources", {
        method: "POST",
        signal: controller.signal,
      }),
    );
    expect(error.code).toBe("cancelled");
    expect(error.message).toContain(
      "verify the resource state before retrying",
    );
    expect(error.message).not.toContain(api_key);
    parse.mockRestore();
  });

  test("cancellation while reading an error body is not swallowed", async () => {
    const controller = new AbortController();
    const response = new Response(null, { status: 401 });
    const parse = spyOn(response, "json").mockImplementation(async () => {
      controller.abort(api_key);
      throw new Error(api_key);
    });
    const client = new ProviderHttp("Example", base_url, {
      api_key,
      fetch: async () => response,
    });
    const error = await errorFrom(
      client.request("/resources", { signal: controller.signal }),
    );
    expect(error.code).toBe("cancelled");
    expect(error.message).toBe("Operation cancelled.");
    parse.mockRestore();
  });

  test("timeouts abort fetches and describe ambiguous mutations without retrying", async () => {
    const requests: Request[] = [];
    const client = new ProviderHttp("Example", base_url, {
      api_key,
      timeout_ms: 5,
      fetch: async (request) => {
        requests.push(request);
        return new Promise<Response>(() => {});
      },
    });
    const error = await errorFrom(
      client.request("/resources", { method: "POST", body: {} }),
    );
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("timed out");
    expect(error.message).toContain(
      "verify the resource state before retrying",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  test("timeouts include response-body reading and retain network_error", async () => {
    for (const status of [200, 401]) {
      const response = new Response(new ReadableStream({ start() {} }), {
        status,
      });
      const client = new ProviderHttp("Example", base_url, {
        api_key,
        timeout_ms: 5,
        fetch: async () => response,
      });
      const error = await errorFrom(client.request("/resources"));
      expect(error.code).toBe("network_error");
      expect(error.message).toBe("Example request timed out.");
    }
  });

  test("successful requests remove abort listeners and stop their timeout", async () => {
    const controller = new AbortController();
    const remove_listener = spyOn(controller.signal, "removeEventListener");
    let request_signal: AbortSignal | undefined;
    const client = new ProviderHttp("Example", base_url, {
      api_key,
      timeout_ms: 5,
      fetch: async (request) => {
        request_signal = request.signal;
        return Response.json({});
      },
    });
    await client.request("/resources", { signal: controller.signal });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(remove_listener).toHaveBeenCalledTimes(1);
    expect(request_signal?.aborted).toBe(false);
    remove_listener.mockRestore();
  });
});
