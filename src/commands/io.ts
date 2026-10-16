import {
  autocomplete,
  type CANCEL_SYMBOL,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { AppError } from "../core/errors.ts";
import type { CliIO } from "./context.ts";

const prompt_io = {
  input: process.stdin,
  output: process.stderr,
};

function promptValue<Value>(value: Value | typeof CANCEL_SYMBOL): Value {
  if (isCancel(value)) {
    throw new AppError("cancelled", "Operation cancelled.");
  }
  return value;
}

export const default_io: CliIO = {
  write_out: (value) => process.stdout.write(value),
  write_err: (value) => process.stderr.write(value),
  get output_columns() {
    return process.stdout.isTTY ? process.stdout.columns : undefined;
  },
  is_interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  async read_text(message, options = {}) {
    return promptValue(
      await text({
        ...prompt_io,
        message,
        ...(options.initial_value === undefined
          ? {}
          : { initialValue: options.initial_value }),
        validate: (value) => {
          if (!options.allow_empty && !value?.trim())
            return "A value is required.";
          return options.validate?.(value ?? "");
        },
      }),
    );
  },
  async read_secret(message) {
    return promptValue(
      await password({
        ...prompt_io,
        message,
        mask: "*",
        validate: (value) =>
          value?.trim() ? undefined : "A value is required.",
      }),
    );
  },
  read_stdin: () => Bun.stdin.text(),
  async confirm(message) {
    return promptValue(
      await confirm({ ...prompt_io, message, initialValue: false }),
    );
  },
  async select(message, options, prompt_options = {}) {
    if (options.length === 0) {
      throw new AppError(
        "invalid_input",
        "No options are available to select.",
      );
    }
    const selection = {
      ...prompt_io,
      message,
      options,
      maxItems: 7,
      ...(prompt_options.initial_value === undefined
        ? {}
        : { initialValue: prompt_options.initial_value }),
    };
    return promptValue(
      await (prompt_options.searchable
        ? autocomplete({
            ...selection,
            filter: (search, option) => {
              const query = search.toLocaleLowerCase();
              return [option.label, option.hint, option.value].some((value) =>
                value?.toLocaleLowerCase().includes(query),
              );
            },
          })
        : select(selection)),
    );
  },
  intro: (message) => intro(message, prompt_io),
  outro: (message) => outro(message, prompt_io),
  note: (message, title) => note(message, title, prompt_io),
  progress(message) {
    const cancel_controller = new AbortController();
    const abort = () =>
      cancel_controller.abort(
        new AppError("cancelled", "Operation cancelled."),
      );
    const progress = spinner({
      ...prompt_io,
      cancelMessage: "Operation cancelled.",
      onCancel: abort,
    });
    // Clack's spinner input blocker exits the process on cancellation keys.
    // Cancel before its keypress parser runs so the command can abort cleanly.
    const cancel_input = (chunk: Buffer | string) => {
      const value = chunk.toString();
      if (value.includes("\u0003") || value === "\u001b") {
        progress.cancel("Operation cancelled.");
        process.stdin.off("data", cancel_input);
        abort();
      }
    };
    progress.start(message);
    process.stdin.prependListener("data", cancel_input);
    cancel_controller.signal.addEventListener(
      "abort",
      () => process.stdin.off("data", cancel_input),
      { once: true },
    );
    return {
      signal: cancel_controller.signal,
      stop(message) {
        process.stdin.off("data", cancel_input);
        cancel_controller.signal.throwIfAborted();
        progress.stop(message);
      },
      fail(message) {
        process.stdin.off("data", cancel_input);
        cancel_controller.signal.throwIfAborted();
        progress.error(message);
      },
    };
  },
};
