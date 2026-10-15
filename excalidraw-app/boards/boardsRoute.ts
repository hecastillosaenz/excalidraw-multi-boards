/**
 * Which screen is showing, as a URL query param (D6): `?board=<uuid>` opens
 * that board in the editor; no param means the boards home screen.
 *
 * A query param, not a hash, because Excalidraw already owns the hash for
 * `#room=` / `#json=` links. Other params and the hash are left untouched.
 */

import { appJotaiStore, atom } from "../app-jotai";

export const BOARD_PARAM = "board";

const BOARD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type BoardRoute =
  | { status: "home" }
  | { status: "board"; boardId: string };

export const readBoardIdFromUrl = (): string | null => {
  const id = new URLSearchParams(window.location.search).get(BOARD_PARAM);
  return id && BOARD_ID_RE.test(id) ? id : null;
};

const routeFor = (boardId: string | null): BoardRoute =>
  boardId ? { status: "board", boardId } : { status: "home" };

export const boardRouteAtom = atom<BoardRoute>(routeFor(readBoardIdFromUrl()));

/** The board currently loaded in the editor (for the switcher's label). */
export const activeBoardAtom = atom<{ id: string; name: string } | null>(null);

/** True while the current board is being saved before switching away. */
export const boardSwitchingAtom = atom(false);

/** Id of the board in the editor, or null on the home screen. */
export const getActiveBoardId = () => {
  const route = appJotaiStore.get(boardRouteAtom);
  return route.status === "board" ? route.boardId : null;
};

/** Shows `boardId` (or the home screen when null) without touching the URL. */
export const applyRoute = (boardId: string | null) => {
  appJotaiStore.set(boardRouteAtom, routeFor(boardId));
};

/** Opens a board: updates the URL and (re)mounts the editor for it. */
export const openBoardRoute = (
  boardId: string,
  mode: "push" | "replace" = "push",
) => {
  const url = new URL(window.location.href);
  url.searchParams.set(BOARD_PARAM, boardId);
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
  applyRoute(boardId);
};

/** Goes to the home screen: drops `?board=` and unmounts the editor. */
export const openHomeRoute = (mode: "push" | "replace" = "push") => {
  const url = new URL(window.location.href);
  url.searchParams.delete(BOARD_PARAM);
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
  applyRoute(null);
};
