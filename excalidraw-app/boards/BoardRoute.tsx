import { Fragment, useEffect } from "react";

import { appJotaiStore, useAtomValue } from "../app-jotai";
import { LocalData } from "../data/LocalData";

import {
  BOARDS_PERSISTENCE_ENABLED,
  closeBoardSession,
} from "./boardPersistence";
import { saveBoardBeforeLeaving } from "./boardSwitching";
import { BoardsHome } from "./BoardsHome";
import {
  applyRoute,
  boardRouteAtom,
  boardSwitchingAtom,
  getActiveBoardId,
  openBoardRoute,
  openHomeRoute,
  readBoardIdFromUrl,
} from "./boardsRoute";

import "./boards.scss";

/**
 * Owns "which screen is showing": the boards home (no `?board=`) or the
 * editor for one board. The editor subtree, including its API provider, is
 * keyed by board id, so changing board remounts everything: undo/redo
 * history, selection and image bookkeeping start clean (R7). On the home
 * screen the editor isn't mounted at all.
 */
export const BoardRoute = ({ children }: { children: React.ReactNode }) => {
  const route = useAtomValue(boardRouteAtom);
  const switching = useAtomValue(boardSwitchingAtom);

  // browser back / forward
  useEffect(() => {
    if (!BOARDS_PERSISTENCE_ENABLED) {
      return;
    }
    const onPopState = async () => {
      const target = readBoardIdFromUrl(); // null = the home screen
      const current = getActiveBoardId(); // null = we are on the home screen
      if (target === current) {
        return;
      }
      if (current === null) {
        applyRoute(target); // nothing is open, nothing to save
        return;
      }
      // the URL already moved, but the editor still shows the old board
      appJotaiStore.set(boardSwitchingAtom, true);
      try {
        if (await saveBoardBeforeLeaving()) {
          LocalData.fileStorage.reset();
          if (target === null) {
            closeBoardSession();
            openHomeRoute("replace");
          } else {
            openBoardRoute(target, "replace");
          }
        } else {
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

  return (
    <>
      {route.status === "home" ? (
        <BoardsHome />
      ) : (
        <Fragment key={route.boardId}>{children}</Fragment>
      )}
      {switching && (
        <div className="boards-switching-veil" role="status">
          <span>Guardando…</span>
        </div>
      )}
    </>
  );
};
