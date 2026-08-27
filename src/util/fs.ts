/**
 * Filesystem primitives shared by the config layer, the run store and the agent's
 * read-only toolset. One copy of "is this ENOENT", "does this exist", "is this path
 * inside the sandbox" — three modules were about to grow their own.
 */
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** True for the errors that mean "not there", as opposed to "there and broken". */
export const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Existence check that distinguishes a file from a directory; rethrows real errors. */
export const pathExists = async (
  path: string,
  kind: "file" | "dir",
): Promise<boolean> => {
  try {
    const info = await stat(path);
    return kind === "dir" ? info.isDirectory() : info.isFile();
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
};

/** `mkdir -p`. Idempotent, and safe to call on every write. */
export const ensureDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
};

/** Reads a UTF-8 file. An absent file is `undefined`, not an error. */
export const readTextFile = async (
  file: string,
): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
};

/** Writes a UTF-8 file, creating its directory. Returns the path written. */
export const writeTextFile = async (
  file: string,
  text: string,
): Promise<string> => {
  await ensureDir(dirname(file));
  await writeFile(file, text, "utf8");
  return file;
};

/**
 * Real path of `target`, resolving symlinks on every segment that exists. Segments that do
 * not exist yet are appended verbatim, so a path can be checked BEFORE it is created.
 */
const realPathOf = async (target: string): Promise<string> => {
  const trailing: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      const real = await realpath(current);
      return trailing.length > 0 ? join(real, ...trailing) : real;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        return resolve(target);
      }
      trailing.unshift(basename(current));
      current = parent;
    }
  }
};

/**
 * Sandbox containment: resolve `target` (relative paths against `root`) and prove the real
 * path sits inside the real root. Returns the resolved absolute path, or `undefined` when
 * it escapes — a symlink pointing out of the tree escapes, which is the whole point of
 * resolving before comparing.
 */
export const resolveWithinRoot = async (
  target: string,
  root: string,
): Promise<string | undefined> => {
  const realRoot = await realPathOf(root);
  const absolute = isAbsolute(target) ? target : join(realRoot, target);
  const real = await realPathOf(absolute);
  return real === realRoot || real.startsWith(`${realRoot}${sep}`)
    ? real
    : undefined;
};
