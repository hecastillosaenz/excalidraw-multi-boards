import http from "node:http";

import { ApiError } from "./errors.ts";
import { BoardStore } from "./store.ts";
import {
  isPlainObject,
  isPng,
  parseBoardId,
  parseName,
  parseScene,
  parseViewState,
} from "./validation.ts";

import type { AddressInfo } from "node:net";

export const MAX_BODY_BYTES = 50 * 1024 * 1024; // N2
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** Only ever bound to loopback (D8). Not configurable on purpose. */
const HOST = "127.0.0.1";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
};

const sendEmpty = (res: http.ServerResponse, status: number) => {
  res.writeHead(status, { "Cache-Control": "no-store" });
  res.end();
};

const hostnameOf = (value: string) => {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
};

/**
 * The server has no CORS headers, but a page open in the same browser could
 * still fire "simple" requests at 127.0.0.1 (CSRF) or reach us through DNS
 * rebinding. Browsers always attach `Origin` to cross-origin writes, and the
 * `Host` header exposes rebinding, so both must be local. The dev-server port
 * is free to vary, hence only the hostname is checked.
 */
const assertLocalRequest = (req: http.IncomingMessage) => {
  const host = hostnameOf(`http://${req.headers.host ?? ""}`);
  const origin = req.headers.origin;
  if (
    !host ||
    !LOCAL_HOSTNAMES.has(host) ||
    (origin !== undefined && !LOCAL_HOSTNAMES.has(hostnameOf(origin) ?? ""))
  ) {
    throw new ApiError(403, "forbidden", "Only local requests are allowed.");
  }
};

const readBody = (req: http.IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const tooLarge = () =>
      new ApiError(413, "payload_too_large", `Body exceeds ${limit} bytes.`);
    const chunks: Buffer[] = [];
    let size = 0;
    // An oversized body is read to the end but never stored: closing the
    // socket while the client is still uploading would surface as an opaque
    // network error instead of the 413 we want to deliver.
    let exceeded = Number(req.headers["content-length"] ?? 0) > limit;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) {
        chunks.push(chunk);
      }
    });
    req.on("end", () =>
      exceeded ? reject(tooLarge()) : resolve(Buffer.concat(chunks)),
    );
    req.on("error", reject);
  });

const readJsonObject = async (
  req: http.IncomingMessage,
  limit: number,
  { optional }: { optional: boolean },
): Promise<Record<string, unknown>> => {
  const raw = await readBody(req, limit);
  if (raw.length === 0) {
    if (optional) {
      return {};
    }
    throw new ApiError(400, "invalid_body", "A JSON body is required.");
  }
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json", "Body is not valid JSON.");
  }
  if (!isPlainObject(parsed)) {
    throw new ApiError(400, "invalid_body", "Body must be a JSON object.");
  }
  return parsed;
};

const methodNotAllowed = (allowed: string[]) =>
  new ApiError(405, "method_not_allowed", `Allowed: ${allowed.join(", ")}.`);

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ApiError(400, "invalid_id", "Board id must be a UUID v4.");
  }
};

type Options = { maxBodyBytes: number };

const route = async (
  store: BoardStore,
  opts: Options,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => {
  assertLocalRequest(req);

  const method = req.method ?? "GET";
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const [api, resource, rawId, sub, ...rest] = pathname
    .split("/")
    .filter(Boolean);

  if (api !== "api" || rest.length > 0) {
    throw new ApiError(404, "not_found", "Unknown route.");
  }

  if (resource === "health" && rawId === undefined) {
    if (method !== "GET") {
      throw methodNotAllowed(["GET"]);
    }
    return sendJson(res, 200, { ok: true, dir: store.dir });
  }

  if (resource !== "boards") {
    throw new ApiError(404, "not_found", "Unknown route.");
  }

  // /api/boards
  if (rawId === undefined) {
    if (method === "GET") {
      return sendJson(res, 200, await store.list());
    }
    if (method === "POST") {
      const body = await readJsonObject(req, opts.maxBodyBytes, {
        optional: true,
      });
      const meta = await store.create({
        name: body.name === undefined ? undefined : parseName(body.name),
        scene: body.scene === undefined ? undefined : parseScene(body.scene),
      });
      return sendJson(res, 201, meta);
    }
    throw methodNotAllowed(["GET", "POST"]);
  }

  // validate the id before touching the body or the disk
  const id = parseBoardId(decodeSegment(rawId));

  // /api/boards/:id
  if (sub === undefined) {
    switch (method) {
      case "GET":
        return sendJson(res, 200, await store.read(id));
      case "PUT": {
        const body = await readJsonObject(req, opts.maxBodyBytes, {
          optional: false,
        });
        if (
          body.baseUpdatedAt !== undefined &&
          body.baseUpdatedAt !== null &&
          typeof body.baseUpdatedAt !== "string"
        ) {
          throw new ApiError(
            400,
            "invalid_body",
            "baseUpdatedAt must be a string.",
          );
        }
        const meta = await store.save(id, {
          scene: parseScene(body.scene),
          baseUpdatedAt: body.baseUpdatedAt ?? undefined,
          viewState: parseViewState(body.viewState),
        });
        return sendJson(res, 200, meta);
      }
      case "PATCH": {
        const body = await readJsonObject(req, opts.maxBodyBytes, {
          optional: false,
        });
        return sendJson(res, 200, await store.rename(id, parseName(body.name)));
      }
      case "DELETE":
        await store.remove(id);
        return sendEmpty(res, 204);
      default:
        throw methodNotAllowed(["GET", "PUT", "PATCH", "DELETE"]);
    }
  }

  // /api/boards/:id/duplicate
  if (sub === "duplicate") {
    if (method !== "POST") {
      throw methodNotAllowed(["POST"]);
    }
    return sendJson(res, 201, await store.duplicate(id));
  }

  // /api/boards/:id/thumbnail
  if (sub === "thumbnail") {
    if (method === "GET") {
      const png = await store.getThumbnail(id);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": png.length,
        "Cache-Control": "no-cache",
      });
      return res.end(png);
    }
    if (method === "PUT") {
      if (req.headers["content-type"] !== "image/png") {
        throw new ApiError(
          415,
          "unsupported_media_type",
          "Content-Type must be image/png.",
        );
      }
      const png = await readBody(req, MAX_THUMBNAIL_BYTES);
      if (!isPng(png)) {
        throw new ApiError(400, "invalid_png", "Body is not a PNG image.");
      }
      await store.setThumbnail(id, png);
      return sendEmpty(res, 204);
    }
    throw methodNotAllowed(["GET", "PUT"]);
  }

  throw new ApiError(404, "not_found", "Unknown route.");
};

export const startBoardsServer = async (opts: {
  dir: string;
  /** 0 picks a free port (tests). */
  port: number;
  maxBodyBytes?: number;
}) => {
  const store = new BoardStore(opts.dir);
  await store.init();
  const options: Options = {
    maxBodyBytes: opts.maxBodyBytes ?? MAX_BODY_BYTES,
  };

  const server = http.createServer((req, res) => {
    route(store, options, req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof ApiError) {
        sendJson(res, error.status, {
          error: error.code,
          message: error.message,
        });
        return;
      }
      console.error("[boards-server] unexpected error:", error);
      sendJson(res, 500, { error: "internal", message: "Internal error." });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    dir: store.dir,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};
