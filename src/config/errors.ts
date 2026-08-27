/**
 * One error type for everything the config layer rejects. Every message names the
 * offending file and, where there is one, the fix — `yama doctor` prints these verbatim.
 */
export class ConfigError extends Error {
  /** Absolute path of the file the problem is in, when the problem has a file. */
  readonly file?: string;
  /** What the operator should do about it. */
  readonly hint?: string;

  constructor(
    message: string,
    options?: { file?: string; hint?: string; cause?: unknown },
  ) {
    super(options?.hint ? `${message}\n  fix: ${options.hint}` : message, {
      cause: options?.cause,
    });
    this.name = "ConfigError";
    this.file = options?.file;
    this.hint = options?.hint;
  }
}
