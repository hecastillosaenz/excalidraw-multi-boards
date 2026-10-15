/**
 * Which board is open, as a URL query param (D6): `?board=<uuid>`.
 *
 * A query param, not a hash, because Excalidraw already owns the hash for
 * `#room=` / `#json=` links. Other params and the hash are left untouched.
 */

import { appJotaiStore, atom } from "../app-jotai";

import { createBoard, listBoards } from "./boardsApi";

export const BOARD_PARAM = "board";

const BOARD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type BoardRoute =
  | { status: "resolving" }
  /** `boardId: null` = no board could be chosen (boards-server unusable). */
  | { status: "ready"; boardId: string | null };

export const readBoardIdFromUrl = (): string | null => {
  const id = new URLSearchParams(window.location.search).get(BOARD_PARAM);
  return id && BOARD_ID_RE.test(id) ? id : null;
};

export const boardRouteAtom = atom<BoardRoute>(
  ((): BoardRoute => {
    const boardId = readBoardIdFromUrl();
    return boardId ? { status: "ready", boardId } : { status: "resolving" };
  })(),
);

/** The board currently loaded in the editor (for the switcher's label). */
export const activeBoardAtom = atom<{ id: string; name: string } | null>(null);

/** True while the current board is being saved before switching away. */
export const boardSwitchingAtom = atom(false);

export const getActiveBoardId = () => {
  const route = appJotaiStore.get(boardRouteAtom);
  return route.status === "ready" ? route.boardId : null;
};

/** Points the app at `boardId`: updates the URL and remounts the editor. */
export const openBoardRoute = (
  boardId: string,
  mode: "push" | "replace" = "push",
) => {
  const url = new URL(window.location.href);
  url.searchParams.set(BOARD_PARAM, boardId);
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
  appJotaiStore.set(boardRouteAtom, { status: "ready", boardId });
};

let defaultBoardPromise: Promise<string | null> | null = null;

/**
 * Interim behaviour until the home screen exists (Phase 5): with no `?board=`
 * open the most recently modified board, creating the first one if the folder
 * is empty. Memoised so React StrictMode's double effect can't create two.
 */
export const resolveDefaultBoardId = () => {
  defaultBoardPromise ??= (async () => {
    try {
      const [mostRecent] = await listBoards();
      return mostRecent?.id ?? (await createBoard()).id;
    } catch (error) {
      console.error("[boards] could not choose a board:", error);
      return null;
    }
  })();
  return defaultBoardPromise;
};
