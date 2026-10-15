import { AppError, type ErrorCode } from "../core/errors.ts";

export interface HttpOptions {
  api_key: string;
  fetch?: (request: Request) => Promise<Response>;
  timeout_ms?: number;
}

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  expects_json?: boolean;
  mutating?: boolean;
}

function errorCode(status_code: number): ErrorCode {
  if (status_code === 400 || status_code === 422) return "invalid_input";
  if (status_code === 401) return "authentication";
  if (status_code === 403) return "forbidden";
  if (status_code === 404) return "not_found";
  if (status_code === 409) return "conflict";
  if (status_code === 429) return "rate_limit";
  return "provider_error";
}

function decode(value: string): string {
  // Reject multiply encoded traversal as well as paths decoded once by a proxy.
  let decoded = value;
  for (let count = 0; count < 4; count++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  if (decoded.includes("%")) throw new Error("Invalid path encoding.");
  return decoded;
}

function safePath(path: string): boolean {
  return path.split("/").every((segment) => {
    const decoded = decode(segment);
    return decoded !== "." && decoded !== ".." && !/[\\/\p{C}]/u.test(decoded);
  });
}

function decodedValues(value: string): string[] {
  const values = [value];
  for (let count = 0; count < 4; count++) {
    try {
      const decoded = decodeURIComponent(values[values.length - 1] ?? value);
      if (values.includes(decoded)) break;
      values.push(decoded);
    } catch {
      break;
    }
  }
  return values;
}

function detail(value: unknown, api_key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const field of ["error", "message", "detail"] as const) {
    const candidate = record[field];
    if (typeof candidate !== "string") continue;
    return (
      candidate
        .replaceAll(api_key, "[redacted]")
        .replaceAll(encodeURIComponent(api_key), "[redacted]")
        .replace(/\p{C}/gu, " ")
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .slice(0, 500)
        .trim() || undefined
    );
  }
  return undefined;
}

export class ProviderHttp {
  #provider_name: string;
  #base_url: URL;
  #api_key: string;
  #fetch: (request: Request) => Promise<Response>;
  #timeout_ms: number;

  constructor(provider_name: string, base_url: string, options: HttpOptions) {
    if (
      typeof provider_name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/.test(provider_name)
    ) {
      throw new AppError("invalid_input", "A valid provider name is required.");
    }
    if (
      typeof options?.api_key !== "string" ||
      !/^[\x21-\x7e]+$/.test(options.api_key)
    ) {
      throw new AppError("invalid_input", "A nonempty API key is required.");
    }
    const timeout_ms = options.timeout_ms ?? 30_000;
    if (
      !Number.isSafeInteger(timeout_ms) ||
      timeout_ms < 1 ||
      timeout_ms > 2_147_483_647
    ) {
      throw new AppError(
        "invalid_input",
        "timeout_ms must be a positive integer.",
      );
    }
    let parsed_base: URL;
    try {
      if (typeof base_url !== "string" || /[\\?#\p{C}]/u.test(base_url)) {
        throw new Error("Invalid base URL.");
      }
      parsed_base = new URL(base_url);
      const raw_path = base_url
        .slice(base_url.indexOf("://") + 3)
        .replace(/^[^/]*/, "");
      if (
        parsed_base.protocol !== "https:" ||
        parsed_base.username ||
        parsed_base.password ||
        parsed_base.search ||
        parsed_base.hash ||
        !safePath(raw_path)
      ) {
        throw new Error("Invalid base URL.");
      }
      parsed_base.pathname = parsed_base.pathname.replace(/\/+$/, "");
    } catch {
      throw new AppError(
        "invalid_input",
        "A fixed HTTPS API base URL is required.",
      );
    }
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new AppError(
        "invalid_input",
        "The HTTP fetch option must be a function.",
      );
    }
    this.#provider_name = provider_name;
    this.#base_url = parsed_base;
    this.#api_key = options.api_key;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout_ms = timeout_ms;
  }

  #url(path: string): URL {
    try {
      if (
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.startsWith("//") ||
        /[\\#\p{C}]/u.test(path) ||
        !safePath(path.split("?")[0] ?? "")
      ) {
        throw new Error("Invalid request path.");
      }
      const url = new URL(`${this.#base_url.href.replace(/\/$/, "")}${path}`);
      const base_path = this.#base_url.pathname.replace(/\/$/, "");
      if (
        url.origin !== this.#base_url.origin ||
        !url.pathname.startsWith(`${base_path}/`) ||
        decodedValues(url.href).some(
          (decoded) =>
            decoded.includes(this.#api_key) || /Bearer\s+/i.test(decoded),
        )
      ) {
        throw new Error("Invalid request path.");
      }
      for (const key of url.searchParams.keys()) {
        if (
          decodedValues(key).some((decoded) =>
            /^(api[_-]?key|access[_-]?token|authorization|token|key)$/i.test(
              decoded,
            ),
          )
        ) {
          throw new Error("Credentials belong in the authorization header.");
        }
      }
      return url;
    } catch {
      throw new AppError(
        "invalid_input",
        "A safe relative API path is required.",
      );
    }
  }

  async request(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) {
      throw new AppError("cancelled", "Operation cancelled.");
    }
    const url = this.#url(path);
    const method = options.method ?? "GET";
    const mutating = options.mutating ?? method !== "GET";
    const advice = mutating
      ? " The request may have succeeded; verify the resource state before retrying."
      : "";
    const controller = new AbortController();
    let sent = false;
    let interrupted: "cancelled" | "timeout" | undefined;
    const interruptionError = () =>
      interrupted === "cancelled"
        ? new AppError("cancelled", `Operation cancelled.${sent ? advice : ""}`)
        : new AppError(
            "network_error",
            `${this.#provider_name} request timed out.${advice}`,
          );
    let reject_interruption: (reason: AppError) => void = () => {};
    const interruption = new Promise<never>((_resolve, reject) => {
      reject_interruption = reject;
    });
    // A signal can abort during request construction, before the first race.
    void interruption.catch(() => {});
    const interrupt = (reason: "cancelled" | "timeout") => {
      if (interrupted) return;
      interrupted = reason;
      controller.abort();
      reject_interruption(interruptionError());
    };
    const cancel = () => interrupt("cancelled");
    const checkInterrupted = () => {
      if (interrupted) throw interruptionError();
    };
    let request: Request;
    try {
      request = new Request(url.href, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#api_key}`,
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        redirect: "error",
        signal: controller.signal,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new AppError(
        "invalid_input",
        `${this.#provider_name} request could not be encoded.`,
      );
    }
    const timeout = setTimeout(() => interrupt("timeout"), this.#timeout_ms);
    options.signal?.addEventListener("abort", cancel, { once: true });
    const race = <T>(operation: () => Promise<T>): Promise<T> =>
      Promise.race([
        Promise.resolve().then(() => {
          checkInterrupted();
          return operation();
        }),
        interruption,
      ]);
    try {
      if (options.signal?.aborted) cancel();
      checkInterrupted();
      let response: Response;
      try {
        sent = true;
        response = await race(() => this.#fetch(request));
      } catch {
        checkInterrupted();
        throw new AppError(
          "network_error",
          `${this.#provider_name} request failed due to a network error.${advice}`,
        );
      }
      checkInterrupted();
      if (!(response instanceof Response)) {
        throw new AppError(
          "invalid_response",
          `${this.#provider_name} returned an invalid HTTP response.${advice}`,
        );
      }
      if (!response.ok) {
        const value: unknown = await race(() => response.json()).catch(
          () => undefined,
        );
        checkInterrupted();
        const message = detail(value, this.#api_key);
        const ambiguous = response.status >= 500 || response.status === 408;
        throw new AppError(
          errorCode(response.status),
          `${this.#provider_name} rejected the request (HTTP ${response.status}).${message ? ` ${message}` : ""}${ambiguous ? advice : ""}`,
          response.status,
        );
      }
      if (options.expects_json === false) return undefined;
      try {
        const value: unknown = await race(() => response.json());
        checkInterrupted();
        return value;
      } catch {
        checkInterrupted();
        throw new AppError(
          "invalid_response",
          `${this.#provider_name} returned an invalid JSON response.${advice}`,
        );
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
    }
  }
}
