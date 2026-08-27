/**
 * One error type for a store file that exists but cannot be trusted. An ABSENT file is
 * never an error — the run rebuilds it; a CORRUPT one is, because silently rebuilding over
 * a half-written artifact is how a recurring run forgets what it already found.
 */
export class StoreError extends Error {
  readonly file: string;

  constructor(message: string, file: string, cause?: unknown) {
    super(`${file}: ${message}`, { cause });
    this.name = "StoreError";
    this.file = file;
  }
}
