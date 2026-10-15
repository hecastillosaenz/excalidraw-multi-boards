import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 3100;

/** Repo root = parent of `boards-server/`. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * `BOARDS_DIR` (relative values are resolved against the repo root, not the
 * cwd, so the result doesn't depend on where the command is launched from).
 * Default: `../data` next to the repo, i.e. ~/Projects/excalidraw/data.
 */
export const resolveBoardsDir = (
  env: string | undefined = process.env.BOARDS_DIR,
  repoRoot: string = REPO_ROOT,
) => path.resolve(repoRoot, env?.trim() || path.join("..", "data"));

export const resolvePort = (
  env: string | undefined = process.env.BOARDS_PORT,
) => {
  if (!env?.trim()) {
    return DEFAULT_PORT;
  }
  const port = Number(env);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BOARDS_PORT must be an integer 1-65535, got "${env}".`);
  }
  return port;
};

/** realpath of the deepest existing ancestor + the not-yet-created remainder. */
const resolveThroughSymlinks = (target: string) => {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
};

/**
 * Returns the git work tree that contains `dir` (or null). The server refuses
 * to start inside one so board data can never end up committed or wiped by a
 * repo operation.
 */
export const findEnclosingGitRoot = (dir: string): string | null => {
  let current = resolveThroughSymlinks(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};
