import { ApiError } from "./errors.ts";

import type { Scene, ViewState } from "./types.ts";

/** Strict lowercase UUID v4. The only thing ever used to build file paths. */
export const BOARD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const MAX_NAME_LENGTH = 200;
export const DEFAULT_SOURCE = "excalidraw-boards-local";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const parseBoardId = (raw: string): string => {
  if (!BOARD_ID_RE.test(raw)) {
    throw new ApiError(400, "invalid_id", "Board id must be a UUID v4.");
  }
  return raw;
};

export const parseName = (raw: unknown): string => {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH || /\p{Cc}/u.test(name)) {
    throw new ApiError(
      400,
      "invalid_name",
      `Name must be 1-${MAX_NAME_LENGTH} characters without control characters.`,
    );
  }
  return name;
};

export const parseScene = (raw: unknown): Scene => {
  if (
    !isPlainObject(raw) ||
    raw.type !== "excalidraw" ||
    !Array.isArray(raw.elements) ||
    (raw.appState !== undefined && !isPlainObject(raw.appState)) ||
    (raw.files !== undefined && !isPlainObject(raw.files))
  ) {
    throw new ApiError(
      400,
      "invalid_scene",
      'Scene must be an excalidraw document: { type: "excalidraw", elements: [], appState?, files? }.',
    );
  }
  return {
    type: "excalidraw",
    version: typeof raw.version === "number" ? raw.version : 2,
    source: typeof raw.source === "string" ? raw.source : DEFAULT_SOURCE,
    elements: raw.elements,
    appState: (raw.appState as Record<string, unknown> | undefined) ?? {},
    files: (raw.files as Record<string, unknown> | undefined) ?? {},
  };
};

export const parseViewState = (raw: unknown): ViewState | undefined => {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (
    !isPlainObject(raw) ||
    !Number.isFinite(raw.scrollX) ||
    !Number.isFinite(raw.scrollY) ||
    !Number.isFinite(raw.zoom) ||
    (raw.zoom as number) <= 0
  ) {
    throw new ApiError(
      400,
      "invalid_view_state",
      "viewState must be { scrollX, scrollY, zoom } with finite numbers and zoom > 0.",
    );
  }
  return {
    scrollX: raw.scrollX as number,
    scrollY: raw.scrollY as number,
    zoom: raw.zoom as number,
  };
};

export const isPng = (buf: Buffer) =>
  buf.length > PNG_SIGNATURE.length &&
  buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

export const countElements = (scene: Scene) =>
  scene.elements.filter((el) => !(isPlainObject(el) && el.isDeleted === true))
    .length;
