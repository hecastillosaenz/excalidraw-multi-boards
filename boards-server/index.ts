/* eslint-disable no-console -- CLI entry point: the console is its UI. */
import {
  findEnclosingGitRoot,
  resolveBoardsDir,
  resolvePort,
} from "./config.ts";
import { startBoardsServer } from "./server.ts";

const main = async () => {
  const dir = resolveBoardsDir();
  const port = resolvePort();

  const gitRoot = findEnclosingGitRoot(dir);
  if (gitRoot) {
    console.error(
      `[boards-server] Refusing to start: BOARDS_DIR (${dir}) is inside the git work tree ${gitRoot}.\n` +
        "Board data must live outside any repository. Set BOARDS_DIR to another folder.",
    );
    process.exit(1);
  }

  let server;
  try {
    server = await startBoardsServer({ dir, port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `[boards-server] Port ${port} is already in use. Is another boards-server running? (change it with BOARDS_PORT)`,
      );
      process.exit(1);
    }
    throw error;
  }

  console.log(`[boards-server] listening on http://127.0.0.1:${server.port}`);
  console.log(`[boards-server] data folder: ${server.dir}`);

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((error) => {
  console.error("[boards-server] fatal:", error);
  process.exit(1);
});
