import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";

// Same-origin on purpose (D7): the dev server proxies /api to boards-server,
// so there is no CORS and the server port never reaches client code.
const API_BASE = "/api";

export type BoardViewState = { scrollX: number; scrollY: number; zoom: number };

export type BoardMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  elementCount: number;
  viewState?: BoardViewState;
};

export type BoardListItem = Omit<BoardMeta, "viewState"> & {
  hasThumbnail: boolean;
};

export type BoardScene = {
  type: "excalidraw";
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: Partial<AppState>;
  files: Record<string, BinaryFileData>;
};

/** The server answered with a well-formed error `{ error, message }`. */
export class BoardsApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** No usable answer: server down, dev proxy failing, or network error. */
export class BoardsUnreachableError extends Error {}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    throw new BoardsUnreachableError(
      error instanceof Error ? error.message : "network error",
    );
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body: handled below
  }

  if (!res.ok) {
    if (typeof data?.error === "string") {
      throw new BoardsApiError(res.status, data.error, data.message ?? "");
    }
    // e.g. the Vite proxy's bare 500 when boards-server isn't running
    throw new BoardsUnreachableError(`HTTP ${res.status}`);
  }
  return data as T;
};

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const checkHealth = () => request<{ ok: true; dir: string }>("/health");

export const listBoards = () => request<BoardListItem[]>("/boards");

export const createBoard = (name?: string) =>
  request<BoardMeta>("/boards", jsonInit("POST", name ? { name } : {}));

export const getBoard = (id: string) =>
  request<{ meta: BoardMeta; scene: BoardScene }>(`/boards/${id}`);

/**
 * `body` is pre-serialized JSON so a big scene (images as data URLs) is
 * stringified once. `keepalive` lets small requests outlive a closing page.
 */
export const saveBoard = (id: string, body: string, keepalive: boolean) =>
  request<BoardMeta>(`/boards/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive,
  });
