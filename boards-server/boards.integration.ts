import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findEnclosingGitRoot,
  resolveBoardsDir,
  resolvePort,
} from "./config.ts";
import { startBoardsServer } from "./server.ts";

// Every test works in its own throwaway folder under the OS temp dir; the
// user's real data folder is never touched.

type Server = Awaited<ReturnType<typeof startBoardsServer>>;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not-a-real-image-but-has-the-signature"),
]);

const sampleScene = (marker = "a") => ({
  type: "excalidraw",
  version: 2,
  source: "test",
  elements: [
    { id: `${marker}1`, type: "rectangle", isDeleted: false },
    { id: `${marker}2`, type: "ellipse", isDeleted: true },
  ],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {
    [`file-${marker}`]: {
      mimeType: "image/png",
      id: `file-${marker}`,
      dataURL: `data:image/png;base64,${marker.repeat(8)}`,
      created: 1,
    },
  },
});

let root: string;
let dir: string;
let server: Server;
let base: string;

const startServer = async (maxBodyBytes?: number) => {
  server = await startBoardsServer({ dir, port: 0, maxBodyBytes });
  base = `http://127.0.0.1:${server.port}`;
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boards-test-"));
  dir = path.join(root, "data");
  await startServer();
});

afterEach(async () => {
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

const api = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    headers: res.headers,
  };
};

/** Raw request: lets us send paths and headers `fetch` would normalise/forbid. */
const raw = (opts: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });

const create = async (name?: string, scene?: unknown) => {
  const res = await api("POST", "/api/boards", { name, scene });
  expect(res.status).toBe(201);
  return res.json as {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    elementCount: number;
  };
};

const ls = (where = dir) => fs.readdir(where).then((n) => n.sort());

describe("health and listing", () => {
  it("reports health with the data folder", async () => {
    const res = await api("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, dir });
  });

  it("creates the data folder and .trash on startup", async () => {
    expect(await ls()).toEqual([".trash"]);
  });

  it("starts with an empty list", async () => {
    expect((await api("GET", "/api/boards")).json).toEqual([]);
  });

  it("sorts by updatedAt desc and skips unreadable metadata", async () => {
    const first = await create("first");
    const second = await create("second");
    await fs.writeFile(
      path.join(dir, "11111111-1111-4111-8111-111111111111.meta.json"),
      "{ not json",
    );
    await fs.writeFile(path.join(dir, "stray-file.txt"), "ignored");
    const list = (await api("GET", "/api/boards")).json;
    expect(list.map((b: { id: string }) => b.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(list[0]).toMatchObject({ name: "second", hasThumbnail: false });
  });
});

describe("create", () => {
  it("names boards 'Tablero N' by default", async () => {
    expect((await create()).name).toBe("Tablero 1");
    expect((await create()).name).toBe("Tablero 2");
    await create("Tablero 7");
    expect((await create()).name).toBe("Tablero 8");
  });

  it("writes <id>.excalidraw and <id>.meta.json to disk", async () => {
    const meta = await create("mine");
    expect(await ls()).toEqual(
      [".trash", `${meta.id}.excalidraw`, `${meta.id}.meta.json`].sort(),
    );
    const onDisk = JSON.parse(
      await fs.readFile(path.join(dir, `${meta.id}.excalidraw`), "utf8"),
    );
    expect(onDisk).toMatchObject({ type: "excalidraw", version: 2 });
    expect(onDisk.elements).toEqual([]);
  });

  it("can start from an existing scene (import)", async () => {
    const meta = await create("imported", sampleScene());
    expect(meta.elementCount).toBe(1); // deleted elements aren't counted
    const read = await api("GET", `/api/boards/${meta.id}`);
    expect(read.json.scene.files["file-a"].dataURL).toContain("data:image/png");
  });

  it("rejects bad names and scenes", async () => {
    for (const name of ["", "   ", 5, "x".repeat(201), "bad\u0000name"]) {
      expect((await api("POST", "/api/boards", { name })).status).toBe(400);
    }
    for (const scene of [{}, { type: "other", elements: [] }, "text"]) {
      const res = await api("POST", "/api/boards", { scene });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid_scene");
    }
  });
});

describe("read and save", () => {
  it("round-trips the scene with embedded images", async () => {
    const meta = await create("b");
    const put = await api("PUT", `/api/boards/${meta.id}`, {
      scene: sampleScene("z"),
    });
    expect(put.status).toBe(200);
    expect(put.json.elementCount).toBe(1);

    const read = await api("GET", `/api/boards/${meta.id}`);
    expect(read.json.meta.id).toBe(meta.id);
    expect(read.json.scene).toEqual(sampleScene("z"));

    const onDisk = JSON.parse(
      await fs.readFile(path.join(dir, `${meta.id}.excalidraw`), "utf8"),
    );
    expect(onDisk).toEqual(sampleScene("z"));
  });

  it("advances updatedAt on every save, even within one millisecond", async () => {
    const meta = await create("t");
    let previous = meta.updatedAt;
    for (let i = 0; i < 5; i++) {
      const { json } = await api("PUT", `/api/boards/${meta.id}`, {
        scene: sampleScene(),
      });
      expect(json.updatedAt > previous).toBe(true);
      previous = json.updatedAt;
    }
  });

  it("stores the viewState and keeps it when a save omits it", async () => {
    const meta = await create("v");
    const viewState = { scrollX: -120.5, scrollY: 40, zoom: 1.5 };
    await api("PUT", `/api/boards/${meta.id}`, {
      scene: sampleScene(),
      viewState,
    });
    await api("PUT", `/api/boards/${meta.id}`, { scene: sampleScene("q") });
    const read = await api("GET", `/api/boards/${meta.id}`);
    expect(read.json.meta.viewState).toEqual(viewState);
    // the list stays light: no viewState there
    const list = (await api("GET", "/api/boards")).json;
    expect(list[0].viewState).toBeUndefined();
  });

  it("rejects invalid viewState and invalid scenes without touching the file", async () => {
    const meta = await create("keep", sampleScene("k"));
    const before = await fs.readFile(
      path.join(dir, `${meta.id}.excalidraw`),
      "utf8",
    );
    const bad = [
      {
        scene: sampleScene(),
        viewState: { scrollX: "x", scrollY: 0, zoom: 1 },
      },
      { scene: sampleScene(), viewState: { scrollX: 0, scrollY: 0, zoom: 0 } },
      { scene: { type: "excalidraw" } },
      { scene: sampleScene(), baseUpdatedAt: 5 },
      {},
    ];
    for (const body of bad) {
      expect((await api("PUT", `/api/boards/${meta.id}`, body)).status).toBe(
        400,
      );
    }
    expect(
      await fs.readFile(path.join(dir, `${meta.id}.excalidraw`), "utf8"),
    ).toBe(before);
  });

  it("returns 404 for unknown boards and never creates them on PUT", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect((await api("GET", `/api/boards/${id}`)).status).toBe(404);
    expect(
      (await api("PUT", `/api/boards/${id}`, { scene: sampleScene() })).status,
    ).toBe(404);
    expect(await ls()).toEqual([".trash"]);
  });
});

describe("conflict detection (409)", () => {
  it("accepts the current token and rejects a stale one", async () => {
    const meta = await create("c");
    const ok = await api("PUT", `/api/boards/${meta.id}`, {
      scene: sampleScene("1"),
      baseUpdatedAt: meta.updatedAt,
    });
    expect(ok.status).toBe(200);

    const stale = await api("PUT", `/api/boards/${meta.id}`, {
      scene: sampleScene("2"),
      baseUpdatedAt: meta.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("conflict");

    const read = await api("GET", `/api/boards/${meta.id}`);
    expect(read.json.scene).toEqual(sampleScene("1")); // loser didn't overwrite
  });

  it("lets exactly one of several concurrent saves win", async () => {
    const meta = await create("race");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api("PUT", `/api/boards/${meta.id}`, {
          scene: sampleScene(String(i)),
          baseUpdatedAt: meta.updatedAt,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
  });

  it("keeps the file valid under concurrent saves without a token", async () => {
    const meta = await create("race2");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api("PUT", `/api/boards/${meta.id}`, { scene: sampleScene(String(i)) }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const read = await api("GET", `/api/boards/${meta.id}`);
    expect(read.status).toBe(200);
    expect((await ls()).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("rename", () => {
  it("renames without changing updatedAt (it is the concurrency token)", async () => {
    const meta = await create("old");
    const res = await api("PATCH", `/api/boards/${meta.id}`, {
      name: "  new name  ",
    });
    expect(res.status).toBe(200);
    expect(res.json.name).toBe("new name");
    expect(res.json.updatedAt).toBe(meta.updatedAt);

    // so a save from an editor that loaded before the rename still works
    const save = await api("PUT", `/api/boards/${meta.id}`, {
      scene: sampleScene(),
      baseUpdatedAt: meta.updatedAt,
    });
    expect(save.status).toBe(200);
    expect(save.json.name).toBe("new name"); // saves don't revert the name
  });

  it("rejects invalid names and unknown boards", async () => {
    const meta = await create("n");
    expect(
      (await api("PATCH", `/api/boards/${meta.id}`, { name: "" })).status,
    ).toBe(400);
    expect(
      (
        await api("PATCH", "/api/boards/33333333-3333-4333-8333-333333333333", {
          name: "x",
        })
      ).status,
    ).toBe(404);
  });
});

describe("duplicate", () => {
  it("copies the scene (with images), thumbnail and viewState independently", async () => {
    const source = await create("orig", sampleScene("s"));
    await api("PUT", `/api/boards/${source.id}`, {
      scene: sampleScene("s"),
      viewState: { scrollX: 1, scrollY: 2, zoom: 3 },
    });
    await fetch(`${base}/api/boards/${source.id}/thumbnail`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: PNG,
    });

    const copy = await api("POST", `/api/boards/${source.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.json.id).not.toBe(source.id);
    expect(copy.json.name).toBe("orig (copia)");

    const read = await api("GET", `/api/boards/${copy.json.id}`);
    expect(read.json.scene).toEqual(sampleScene("s"));
    expect(read.json.meta.viewState).toEqual({
      scrollX: 1,
      scrollY: 2,
      zoom: 3,
    });
    const thumb = await fetch(`${base}/api/boards/${copy.json.id}/thumbnail`);
    expect(Buffer.from(await thumb.arrayBuffer())).toEqual(PNG);

    // editing the copy leaves the original alone
    await api("PUT", `/api/boards/${copy.json.id}`, {
      scene: sampleScene("x"),
    });
    const original = await api("GET", `/api/boards/${source.id}`);
    expect(original.json.scene).toEqual(sampleScene("s"));
  });

  it("returns 404 for unknown boards and leaves nothing behind", async () => {
    const res = await api(
      "POST",
      "/api/boards/44444444-4444-4444-8444-444444444444/duplicate",
    );
    expect(res.status).toBe(404);
    expect(await ls()).toEqual([".trash"]);
  });
});

describe("delete → trash", () => {
  it("moves every file to .trash with a timestamp suffix and never unlinks", async () => {
    const meta = await create("bye", sampleScene("d"));
    await fetch(`${base}/api/boards/${meta.id}/thumbnail`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: PNG,
    });
    const original = await fs.readFile(
      path.join(dir, `${meta.id}.excalidraw`),
      "utf8",
    );

    expect((await api("DELETE", `/api/boards/${meta.id}`)).status).toBe(204);

    expect(await ls()).toEqual([".trash"]);
    const trash = await ls(path.join(dir, ".trash"));
    expect(trash).toHaveLength(3);
    for (const suffix of [".excalidraw", ".meta.json", ".thumb.png"]) {
      expect(
        trash.some((n) =>
          new RegExp(
            `^${meta.id}-\\d{8}T\\d+Z${suffix.replace(".", "\\.")}$`,
          ).test(n),
        ),
      ).toBe(true);
    }
    const trashedScene = trash.find((n) => n.endsWith(".excalidraw"))!;
    expect(
      await fs.readFile(path.join(dir, ".trash", trashedScene), "utf8"),
    ).toBe(original);

    expect((await api("GET", "/api/boards")).json).toEqual([]);
    expect((await api("GET", `/api/boards/${meta.id}`)).status).toBe(404);
    expect((await api("DELETE", `/api/boards/${meta.id}`)).status).toBe(404);
  });

  it("keeps earlier trashed copies when ids are reused over time", async () => {
    const a = await create("one");
    await api("DELETE", `/api/boards/${a.id}`);
    const b = await create("two");
    await api("DELETE", `/api/boards/${b.id}`);
    expect(await ls(path.join(dir, ".trash"))).toHaveLength(4);
  });
});

describe("thumbnails", () => {
  it("stores and serves a PNG without bumping updatedAt", async () => {
    const meta = await create("th");
    const put = await fetch(`${base}/api/boards/${meta.id}/thumbnail`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: PNG,
    });
    expect(put.status).toBe(204);

    const get = await fetch(`${base}/api/boards/${meta.id}/thumbnail`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await get.arrayBuffer())).toEqual(PNG);

    const list = (await api("GET", "/api/boards")).json;
    expect(list[0]).toMatchObject({ hasThumbnail: true });
    expect(list[0].updatedAt).toBe(meta.updatedAt);
  });

  it("404s when absent, rejects non-PNG, wrong type, oversize and unknown boards", async () => {
    const meta = await create("th2");
    const url = `${base}/api/boards/${meta.id}/thumbnail`;
    expect((await fetch(url)).status).toBe(404);
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body: "plain text",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body: PNG,
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(url, {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body: Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(
          `${base}/api/boards/55555555-5555-4555-8555-555555555555/thumbnail`,
          {
            method: "PUT",
            headers: { "content-type": "image/png" },
            body: PNG,
          },
        )
      ).status,
    ).toBe(404);
  });
});

describe("input hardening (N2)", () => {
  it("answers 400 invalid_id for malformed ids on every board route", async () => {
    const badIds = [
      "not-a-uuid",
      "1",
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", // uppercase
      "11111111-1111-1111-8111-111111111111", // not v4
      "11111111-1111-4111-8111-111111111111.json",
      "%00",
      "%E0%A4%A", // malformed percent-encoding
    ];
    for (const id of badIds) {
      for (const [method, suffix] of [
        ["GET", ""],
        ["PUT", ""],
        ["PATCH", ""],
        ["DELETE", ""],
        ["POST", "/duplicate"],
        ["GET", "/thumbnail"],
        ["PUT", "/thumbnail"],
      ] as const) {
        const res = await raw({ method, path: `/api/boards/${id}${suffix}` });
        expect(res.status, `${method} ${id}${suffix}`).toBe(400);
        expect(JSON.parse(res.body).error).toBe("invalid_id");
      }
    }
  });

  it("does not let path traversal reach files outside the data folder", async () => {
    const secret = path.join(root, "secret.txt");
    await fs.writeFile(secret, "top secret");
    const attempts = [
      "/api/boards/..%2Fsecret.txt",
      "/api/boards/%2e%2e%2fsecret.txt",
      "/api/boards/..%5Csecret.txt",
      "/api/boards/..%2F..%2F..%2Fetc%2Fpasswd",
      "/api/boards/%2e%2e",
      "/api/boards/../../secret.txt",
      "/api/boards/./../secret.txt",
    ];
    for (const attempt of attempts) {
      for (const method of ["GET", "PUT", "PATCH", "DELETE", "POST"]) {
        const res = await raw({ method, path: attempt });
        expect([400, 404, 405], `${method} ${attempt}`).toContain(res.status);
        expect(res.body).not.toContain("top secret");
      }
    }
    expect(await fs.readFile(secret, "utf8")).toBe("top secret");
    expect(await ls(root)).toEqual(["data", "secret.txt"]);
    expect(await ls()).toEqual([".trash"]);
  });

  it("enforces the body size limit with 413", async () => {
    await server.close();
    await startServer(1024);
    // big enough to overflow socket buffers: the 413 must still arrive intact
    const big = {
      scene: {
        ...sampleScene(),
        appState: { pad: "x".repeat(5 * 1024 * 1024) },
      },
    };
    const res = await api("POST", "/api/boards", big);
    expect(res.status).toBe(413);
    expect(res.json.error).toBe("payload_too_large");
    expect(await ls()).toEqual([".trash"]);
  });

  it("rejects malformed bodies", async () => {
    const meta = await create("bodies");
    const put = (body: string, type = "application/json") =>
      fetch(`${base}/api/boards/${meta.id}`, {
        method: "PUT",
        headers: { "content-type": type },
        body,
      });
    expect((await put("{ nope")).status).toBe(400);
    expect((await put("[1,2]")).status).toBe(400);
    expect((await put("{}", "text/plain")).status).toBe(415);
    expect(
      (await fetch(`${base}/api/boards/${meta.id}`, { method: "PUT" })).status,
    ).toBe(400);
  });

  it("refuses foreign Origin and non-local Host headers", async () => {
    const evil = await raw({
      method: "POST",
      path: "/api/boards",
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    const rebinding = await raw({
      path: "/api/boards",
      headers: { host: "evil.example:3100" },
    });
    expect(rebinding.status).toBe(403);
    expect(await ls()).toEqual([".trash"]);

    // a dev server on any local port is fine (the Vite port varies)
    const local = await raw({
      path: "/api/boards",
      headers: { origin: "http://localhost:3001", host: "localhost:3001" },
    });
    expect(local.status).toBe(200);
  });

  it("answers JSON 404/405 for unknown routes and methods", async () => {
    expect((await api("GET", "/nope")).status).toBe(404);
    expect((await api("GET", "/api/nope")).status).toBe(404);
    expect((await api("GET", "/api/boards/a/b/c/d")).status).toBe(404);
    expect((await api("DELETE", "/api/boards")).status).toBe(405);
    expect((await api("POST", "/api/health")).status).toBe(405);
  });
});

describe("durability", () => {
  it("leaves no temp files behind and reflects everything on disk after a restart", async () => {
    const a = await create("a", sampleScene("a"));
    const b = await create("b");
    await api("PUT", `/api/boards/${b.id}`, { scene: sampleScene("b") });
    await api("PATCH", `/api/boards/${a.id}`, { name: "renamed" });
    expect((await ls()).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    await server.close();
    await startServer(); // new process state, same folder

    const list = (await api("GET", "/api/boards")).json;
    expect(list.map((x: { name: string }) => x.name).sort()).toEqual([
      "b",
      "renamed",
    ]);
    const read = await api("GET", `/api/boards/${a.id}`);
    expect(read.json.scene).toEqual(sampleScene("a"));
  });
});

describe("config", () => {
  it("defaults the data folder to ../data next to the repo", () => {
    expect(resolveBoardsDir(undefined, "/home/u/Projects/excalidraw/app")).toBe(
      "/home/u/Projects/excalidraw/data",
    );
    expect(resolveBoardsDir("  ", "/r/app")).toBe("/r/data");
  });

  it("resolves BOARDS_DIR against the repo root when relative, as-is when absolute", () => {
    expect(resolveBoardsDir("../boards", "/r/app")).toBe("/r/boards");
    expect(resolveBoardsDir("/abs/boards", "/r/app")).toBe("/abs/boards");
  });

  it("validates BOARDS_PORT", () => {
    expect(resolvePort(undefined)).toBe(3100);
    expect(resolvePort("4000")).toBe(4000);
    for (const bad of ["abc", "0", "70000", "3.5"]) {
      expect(() => resolvePort(bad)).toThrow(/BOARDS_PORT/);
    }
  });

  it("detects a data folder inside a git work tree (even one that doesn't exist yet)", async () => {
    const repo = path.join(root, "repo");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    expect(findEnclosingGitRoot(path.join(repo, "data"))).toBe(
      await fs.realpath(repo),
    );
    expect(findEnclosingGitRoot(path.join(repo, "a", "b", "c"))).toBe(
      await fs.realpath(repo),
    );
    expect(findEnclosingGitRoot(dir)).toBeNull(); // sibling of the repo, outside
  });

  it("sees through symlinks pointing into a repo", async () => {
    const repo = path.join(root, "repo2");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.mkdir(path.join(repo, "inside"));
    const link = path.join(root, "link");
    await fs.symlink(path.join(repo, "inside"), link);
    expect(findEnclosingGitRoot(link)).toBe(await fs.realpath(repo));
  });
});
