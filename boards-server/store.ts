import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./errors.ts";
import {
  BOARD_ID_RE,
  DEFAULT_SOURCE,
  MAX_NAME_LENGTH,
  countElements,
  isPlainObject,
} from "./validation.ts";

import type { BoardListItem, BoardMeta, Scene, ViewState } from "./types.ts";

const META_SUFFIX = ".meta.json";
const SCENE_SUFFIX = ".excalidraw";
const THUMB_SUFFIX = ".thumb.png";
const TRASH_DIR = ".trash";

const isEnoent = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const emptyScene = (): Scene => ({
  type: "excalidraw",
  version: 2,
  source: DEFAULT_SOURCE,
  elements: [],
  appState: {},
  files: {},
});

/** Always moves forward, even within the same millisecond (used for 409s). */
const nextTimestamp = (previous?: string) =>
  new Date(
    Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0),
  ).toISOString();

/**
 * temp file + fsync + rename: readers see either the old or the new file,
 * never a half-written one, even if the process dies mid-write (N1).
 */
const writeFileAtomic = async (target: string, data: string | Buffer) => {
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
};

const copyFileAtomic = async (from: string, to: string) => {
  const tmp = `${to}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(from, tmp);
    await fs.rename(tmp, to);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
};

const isBoardMeta = (v: unknown): v is BoardMeta =>
  isPlainObject(v) &&
  typeof v.id === "string" &&
  BOARD_ID_RE.test(v.id) &&
  typeof v.name === "string" &&
  typeof v.createdAt === "string" &&
  typeof v.updatedAt === "string" &&
  typeof v.elementCount === "number";

export class BoardStore {
  dir: string;
  private trashDir: string;
  private locks = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.trashDir = path.join(this.dir, TRASH_DIR);
  }

  async init() {
    await fs.mkdir(this.trashDir, { recursive: true });
  }

  /**
   * Paths are built only from a regex-validated id plus a fixed suffix, and
   * re-checked to be direct children of the data dir (defense in depth, N2).
   */
  private paths(id: string) {
    if (!BOARD_ID_RE.test(id)) {
      throw new ApiError(400, "invalid_id", "Board id must be a UUID v4.");
    }
    const at = (suffix: string) => {
      const file = path.join(this.dir, `${id}${suffix}`);
      if (path.dirname(file) !== this.dir) {
        throw new ApiError(400, "invalid_id", "Board id must be a UUID v4.");
      }
      return file;
    };
    return {
      scene: at(SCENE_SUFFIX),
      meta: at(META_SUFFIX),
      thumb: at(THUMB_SUFFIX),
    };
  }

  /** Serializes read-modify-write cycles per board inside this process. */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.locks.set(id, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) {
        this.locks.delete(id);
      }
    }
  }

  private notFound(id: string) {
    return new ApiError(404, "not_found", `Board ${id} does not exist.`);
  }

  private async readMeta(id: string): Promise<BoardMeta> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths(id).meta, "utf8");
    } catch (error) {
      throw isEnoent(error) ? this.notFound(id) : error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!isBoardMeta(parsed) || parsed.id !== id) {
      throw new ApiError(
        500,
        "corrupt_board",
        `Metadata of board ${id} is unreadable. The files were left untouched.`,
      );
    }
    return parsed;
  }

  private writeMeta(meta: BoardMeta) {
    return writeFileAtomic(
      this.paths(meta.id).meta,
      JSON.stringify(meta, null, 2),
    );
  }

  /** The listing is computed from the folder (D3): no central index to desync. */
  async list(): Promise<BoardListItem[]> {
    const names = await fs.readdir(this.dir);
    const ids = names
      .filter((n) => n.endsWith(META_SUFFIX))
      .map((n) => n.slice(0, -META_SUFFIX.length))
      .filter((id) => BOARD_ID_RE.test(id));

    const items = await Promise.all(
      ids.map(async (id): Promise<BoardListItem | null> => {
        try {
          const { viewState: _viewState, ...meta } = await this.readMeta(id);
          const hasThumbnail = await fs
            .access(this.paths(id).thumb)
            .then(() => true)
            .catch(() => false);
          return { ...meta, hasThumbnail };
        } catch (error) {
          const reason = error instanceof Error ? error.message : error;
          console.warn(
            `[boards-server] skipping unreadable board ${id}: ${reason}`,
          );
          return null;
        }
      }),
    );

    return items
      .filter((item): item is BoardListItem => item !== null)
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.name.localeCompare(b.name),
      );
  }

  private async nextDefaultName() {
    let max = 0;
    for (const { name } of await this.list()) {
      const match = /^Tablero (\d+)$/.exec(name);
      if (match) {
        max = Math.max(max, Number(match[1]));
      }
    }
    return `Tablero ${max + 1}`;
  }

  async create(input: { name?: string; scene?: Scene }): Promise<BoardMeta> {
    const id = randomUUID();
    const scene = input.scene ?? emptyScene();
    const now = nextTimestamp();
    const meta: BoardMeta = {
      id,
      name: input.name ?? (await this.nextDefaultName()),
      createdAt: now,
      updatedAt: now,
      elementCount: countElements(scene),
    };
    await this.withLock(id, async () => {
      // scene first: a crash in between leaves an invisible orphan, never a
      // listed board without content.
      await writeFileAtomic(this.paths(id).scene, JSON.stringify(scene));
      await this.writeMeta(meta);
    });
    return meta;
  }

  async read(id: string): Promise<{ meta: BoardMeta; scene: Scene }> {
    const meta = await this.readMeta(id);
    let raw: string;
    try {
      raw = await fs.readFile(this.paths(id).scene, "utf8");
    } catch (error) {
      throw isEnoent(error)
        ? new ApiError(500, "corrupt_board", `Board ${id} has no scene file.`)
        : error;
    }
    try {
      return { meta, scene: JSON.parse(raw) as Scene };
    } catch {
      throw new ApiError(
        500,
        "corrupt_board",
        `Scene of board ${id} is not valid JSON. The file was left untouched.`,
      );
    }
  }

  /** `baseUpdatedAt` is the optimistic-concurrency token (S2 → 409). */
  save(
    id: string,
    input: { scene: Scene; baseUpdatedAt?: string; viewState?: ViewState },
  ): Promise<BoardMeta> {
    return this.withLock(id, async () => {
      const current = await this.readMeta(id);
      if (
        input.baseUpdatedAt !== undefined &&
        input.baseUpdatedAt !== current.updatedAt
      ) {
        throw new ApiError(
          409,
          "conflict",
          "The board changed on disk since you loaded it (another tab?). Reload to avoid overwriting.",
        );
      }
      const viewState = input.viewState ?? current.viewState;
      const meta: BoardMeta = {
        ...current,
        updatedAt: nextTimestamp(current.updatedAt),
        elementCount: countElements(input.scene),
        ...(viewState ? { viewState } : {}),
      };
      await writeFileAtomic(this.paths(id).scene, JSON.stringify(input.scene));
      await this.writeMeta(meta);
      return meta;
    });
  }

  /**
   * Rename deliberately keeps `updatedAt`: it is the concurrency token, so
   * bumping it would make the open editor's next save fail with a false 409.
   */
  rename(id: string, name: string): Promise<BoardMeta> {
    return this.withLock(id, async () => {
      const meta = { ...(await this.readMeta(id)), name };
      await this.writeMeta(meta);
      return meta;
    });
  }

  duplicate(id: string): Promise<BoardMeta> {
    return this.withLock(id, async () => {
      const source = await this.readMeta(id);
      const copyId = randomUUID();
      const from = this.paths(id);
      const to = this.paths(copyId);
      const now = nextTimestamp();
      const suffix = " (copia)";
      const meta: BoardMeta = {
        ...source,
        id: copyId,
        name: source.name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await copyFileAtomic(from.scene, to.scene);
        await copyFileAtomic(from.thumb, to.thumb).catch((error) => {
          if (!isEnoent(error)) {
            throw error;
          }
        });
        await this.writeMeta(meta);
      } catch (error) {
        await Promise.all(
          [to.scene, to.thumb, to.meta].map((f) => fs.rm(f, { force: true })),
        );
        throw isEnoent(error) ? this.notFound(id) : error;
      }
      return meta;
    });
  }

  /** Never unlinks: moves to `.trash/<id>-<timestamp>.*` (D5, 5.4). */
  remove(id: string): Promise<void> {
    return this.withLock(id, async () => {
      const files = this.paths(id);
      const stamp = new Date().toISOString().replace(/[-:.]/g, "");
      let moved = 0;
      // meta first: the board disappears from the listing even if we crash
      // halfway, leaving at worst an invisible orphan.
      for (const [file, suffix] of [
        [files.meta, META_SUFFIX],
        [files.scene, SCENE_SUFFIX],
        [files.thumb, THUMB_SUFFIX],
      ] as const) {
        try {
          await fs.rename(
            file,
            path.join(this.trashDir, `${id}-${stamp}${suffix}`),
          );
          moved++;
        } catch (error) {
          if (!isEnoent(error)) {
            throw error;
          }
        }
      }
      if (moved === 0) {
        throw this.notFound(id);
      }
    });
  }

  setThumbnail(id: string, png: Buffer): Promise<void> {
    return this.withLock(id, async () => {
      await this.readMeta(id);
      await writeFileAtomic(this.paths(id).thumb, png);
    });
  }

  async getThumbnail(id: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.paths(id).thumb);
    } catch (error) {
      throw isEnoent(error)
        ? new ApiError(404, "not_found", `Board ${id} has no thumbnail.`)
        : error;
    }
  }
}
