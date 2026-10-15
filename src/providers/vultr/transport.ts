import { AppError, type ErrorCode } from "../../core/errors.ts";

const api_url = "https://api.vultr.com/v2";

export interface VultrOptions {
  api_key: string;
  fetch?: (request: Request) => Promise<Response>;
  timeout_ms?: number;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

function errorCode(status_code: number): ErrorCode {
  if (status_code === 400 || status_code === 422) return "invalid_input";
  if (status_code === 401) return "authentication";
  if (status_code === 403) return "forbidden";
  if (status_code === 404) return "not_found";
  if (status_code === 409) return "conflict";
  if (status_code === 429) return "rate_limit";
  return "provider_error";
}

export class VultrTransport {
  #api_key: string;
  #fetch: (request: Request) => Promise<Response>;
  #timeout_ms: number;

  constructor(options: VultrOptions) {
    if (typeof options.api_key !== "string" || !/^\S+$/.test(options.api_key)) {
      throw new AppError(
        "invalid_input",
        "A nonempty Vultr API key is required.",
      );
    }
    const timeout_ms = options.timeout_ms ?? 30_000;
    if (
      !Number.isSafeInteger(timeout_ms) ||
      timeout_ms < 1 ||
      timeout_ms > 2_147_483_647
    ) {
      throw new AppError(
        "invalid_input",
        "Vultr timeout_ms must be a positive integer.",
      );
    }
    this.#api_key = options.api_key;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout_ms = timeout_ms;
  }

  async request(
    path: string,
    method: Method = "GET",
    body?: Record<string, unknown>,
    expects_json = true,
  ): Promise<unknown> {
    const mutating = method !== "GET";
    const retry_advice = mutating
      ? " The request may have succeeded; verify the instance state before retrying."
      : "";
    const controller = new AbortController();
    let timed_out = false;
    const timeout = setTimeout(() => {
      timed_out = true;
      controller.abort();
    }, this.#timeout_ms);

    try {
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${this.#api_key}`,
      });
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const request = new Request(`${api_url}${path}`, {
        method,
        headers,
        redirect: "error",
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      let response: Response;
      try {
        response = await this.#fetch(request);
      } catch {
        const reason = timed_out
          ? "timed out"
          : "failed due to a network error";
        throw new AppError(
          "network_error",
          `Vultr request ${reason}.${retry_advice}`,
        );
      }

      if (!response.ok) {
        const advice = response.status >= 500 ? retry_advice : "";
        throw new AppError(
          errorCode(response.status),
          `Vultr rejected the request (HTTP ${response.status}).${advice}`,
          response.status,
        );
      }
      if (!expects_json) return undefined;
      try {
        return await response.json();
      } catch {
        throw new AppError(
          "invalid_response",
          `Vultr returned an invalid JSON response.${retry_advice}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
