import { Fragment, useEffect } from "react";

import { appJotaiStore, useAtomValue } from "../app-jotai";
import { LocalData } from "../data/LocalData";

import { BOARDS_PERSISTENCE_ENABLED } from "./boardPersistence";
import { saveBoardBeforeLeaving } from "./boardSwitching";
import {
  boardRouteAtom,
  boardSwitchingAtom,
  getActiveBoardId,
  openBoardRoute,
  readBoardIdFromUrl,
  resolveDefaultBoardId,
} from "./boardsRoute";

import "./boards.scss";

/**
 * Owns "which board is open". Children (the whole editor, including its API
 * provider) are keyed by board id, so changing board remounts everything:
 * undo/redo history, selection and image bookkeeping start clean (R7).
 */
export const BoardRoute = ({ children }: { children: React.ReactNode }) => {
  const route = useAtomValue(boardRouteAtom);
  const switching = useAtomValue(boardSwitchingAtom);

  // no `?board=`: pick one (interim, until the home screen exists)
  useEffect(() => {
    if (!BOARDS_PERSISTENCE_ENABLED || route.status !== "resolving") {
      return;
    }
    resolveDefaultBoardId().then((boardId) => {
      if (boardId) {
        openBoardRoute(boardId, "replace");
      } else {
        appJotaiStore.set(boardRouteAtom, { status: "ready", boardId: null });
      }
    });
  }, [route.status]);

  // browser back / forward
  useEffect(() => {
    if (!BOARDS_PERSISTENCE_ENABLED) {
      return;
    }
    const onPopState = async () => {
      const target = readBoardIdFromUrl();
      const current = getActiveBoardId();
      if (!target || target === current) {
        return;
      }
      // the URL already moved, but the editor still shows the old board
      appJotaiStore.set(boardSwitchingAtom, true);
      try {
        if (await saveBoardBeforeLeaving()) {
          LocalData.fileStorage.reset();
          openBoardRoute(target, "replace");
        } else if (current) {
          openBoardRoute(current, "replace"); // stay: put the URL back
        }
      } finally {
        appJotaiStore.set(boardSwitchingAtom, false);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (!BOARDS_PERSISTENCE_ENABLED) {
    return <>{children}</>;
  }
  if (route.status === "resolving") {
    return null;
  }

  return (
    <>
      <Fragment key={route.boardId ?? "no-board"}>{children}</Fragment>
      {switching && (
        <div className="boards-switching-veil" role="status">
          <span>Guardando…</span>
        </div>
      )}
    </>
  );
};
