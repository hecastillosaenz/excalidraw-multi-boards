/* eslint-disable no-console -- CLI launcher: the console is its UI. */
// One command to run everything (D12): `yarn start:boards`.
//
// Starts boards-server first, waits until it answers, then starts the usual
// `yarn start` (Vite). Ctrl-C stops both. If a boards-server is already
// running on the port it is reused instead of failing with "port in use".
//
// Plain JavaScript on purpose: it must run, and explain itself, even on a
// Node too old to execute the TypeScript server.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.BOARDS_PORT) || 3100;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const STARTUP_TIMEOUT_MS = 15000;

/** Node runs .ts files without flags since 22.18 (and 23.6). */
const supportsTypeStripping = ([major, minor]) =>
  major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);

const log = (message) => console.log(`[start:boards] ${message}`);

const nodeVersion = process.versions.node.split(".").map(Number);
if (!supportsTypeStripping(nodeVersion)) {
  console.error(
    `[start:boards] Tu Node es ${process.versions.node}. El servidor de tableros necesita Node 22.18 o superior (ejecuta TypeScript directamente).\n` +
      "Actualiza Node (por ejemplo con nvm: `nvm install 22`) y vuelve a intentarlo.",
  );
  process.exit(1);
}

const isServerUp = async () => {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
};

/** Starts a child in its own process group so we can stop its whole tree. */
const run = (command, args, options = {}) =>
  spawn(command, args, { cwd: ROOT, detached: true, ...options });

const stopGroup = (child) => {
  if (child && child.exitCode === null && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
};

/** Prints a child's output line by line with a prefix. */
const prefixOutput = (child, prefix) => {
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.on("data", (chunk) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        console.log(`${prefix} ${line}`);
      }
    });
  }
};

let server = null;
let app = null;
let shuttingDown = false;

const shutdown = (code) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopGroup(app);
  stopGroup(server);
  // give both a moment to flush, then leave
  setTimeout(() => process.exit(code), 400);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const startServer = async () => {
  if (await isServerUp()) {
    log(
      `el servidor de tableros ya está activo en el puerto ${PORT}: se reutiliza.`,
    );
    return;
  }

  log(`iniciando el servidor de tableros (puerto ${PORT})…`);
  server = run(process.execPath, ["boards-server/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefixOutput(server, "[boards]");

  let exited = false;
  server.on("exit", (code) => {
    exited = true;
    if (!shuttingDown) {
      console.error(
        `[start:boards] el servidor de tableros se detuvo (código ${code}). Se cierra todo para que no trabajes sin guardado.`,
      );
      shutdown(1);
    }
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!(await isServerUp())) {
    if (exited) {
      process.exit(1); // its own message was already printed above
    }
    if (Date.now() > deadline) {
      console.error(
        `[start:boards] el servidor no respondió en ${
          STARTUP_TIMEOUT_MS / 1000
        } s.`,
      );
      shutdown(1);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

if ((await startServer()) === false) {
  process.exit(1);
}

log("iniciando la app (yarn start)…");
app = run("yarn", ["start"], { stdio: "inherit" });
app.on("exit", (code) => {
  if (!shuttingDown) {
    log(`la app se detuvo (código ${code}).`);
    shutdown(code ?? 0);
  }
});
