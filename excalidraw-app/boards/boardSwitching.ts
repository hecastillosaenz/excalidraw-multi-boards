import { appJotaiStore } from "../app-jotai";
import { LocalData } from "../data/LocalData";

import {
  closeBoardSession,
  flushBoardThumbnail,
  settleBoardSaves,
} from "./boardPersistence";
import { createBoard } from "./boardsApi";
import {
  boardSwitchingAtom,
  getActiveBoardId,
  openBoardRoute,
  openHomeRoute,
} from "./boardsRoute";

const SAVE_ATTEMPTS = 3;

/**
 * F9: before leaving a board, save it NOW and wait for the server to confirm,
 * so no stroke is lost. If saving keeps failing the user decides.
 * @returns whether it is OK to leave (saved, or the user accepted the loss).
 */
export const saveBoardBeforeLeaving = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    LocalData.flushSave();
    if (await settleBoardSaves()) {
      // so the home screen shows the board as it is now
      await flushBoardThumbnail();
      return true;
    }
  }
  return window.confirm(
    "No se pudieron guardar los últimos cambios de este tablero.\n\n" +
      "Si cambias de tablero ahora, esos cambios se perderán. ¿Cambiar de todos modos?",
  );
};

/** Runs `action` behind a full-screen veil so nothing is drawn mid-switch. */
const whileSwitching = async <T>(action: () => Promise<T>): Promise<T> => {
  appJotaiStore.set(boardSwitchingAtom, true);
  try {
    return await action();
  } finally {
    appJotaiStore.set(boardSwitchingAtom, false);
  }
};

/** Saves the open board, then opens `boardId` in a fresh editor. */
export const switchToBoard = (boardId: string) =>
  whileSwitching(async () => {
    if (boardId === getActiveBoardId()) {
      return;
    }
    if (!(await saveBoardBeforeLeaving())) {
      return;
    }
    // per-board image bookkeeping must not leak into the next board
    LocalData.fileStorage.reset();
    openBoardRoute(boardId, "push");
  });

/** Saves the open board, creates a new one and opens it. */
export const createAndOpenBoard = () =>
  whileSwitching(async () => {
    if (!(await saveBoardBeforeLeaving())) {
      return;
    }
    const { id } = await createBoard();
    LocalData.fileStorage.reset();
    openBoardRoute(id, "push");
  });

/** Saves the open board and goes back to the boards home screen. */
export const goToHome = () =>
  whileSwitching(async () => {
    if (!(await saveBoardBeforeLeaving())) {
      return;
    }
    LocalData.fileStorage.reset();
    closeBoardSession();
    openHomeRoute("push");
  });
