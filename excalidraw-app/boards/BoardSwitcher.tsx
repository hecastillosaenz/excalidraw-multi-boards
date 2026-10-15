import { useEffect, useRef, useState } from "react";

import { useAtomValue } from "../app-jotai";

import { createAndOpenBoard, switchToBoard } from "./boardSwitching";
import { listBoards } from "./boardsApi";
import { activeBoardAtom } from "./boardsRoute";

import type { BoardListItem } from "./boardsApi";

/**
 * Top-bar control (F7): shows the open board's name and lets you jump to
 * another board or create one. Rendered through the editor's official
 * `renderTopLeftUI` slot.
 */
export const BoardSwitcher = () => {
  const active = useAtomValue(activeBoardAtom);
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<BoardListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    listBoards()
      .then(setBoards)
      .catch(() => setError("No se pudo leer la lista de tableros."));

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!active) {
    return null;
  }

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
      setOpen(false);
    } catch (e) {
      console.error("[boards] switch failed:", e);
      setError("No se pudo cambiar de tablero. Revisa el servidor.");
    }
  };

  return (
    <div className="boards-switcher" ref={rootRef}>
      <button
        type="button"
        className="boards-switcher__button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={active.name}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="boards-switcher__name">{active.name}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="boards-switcher__menu" role="menu">
          {boards === null && !error && (
            <div className="boards-switcher__note">Cargando…</div>
          )}
          {boards?.map((board) => (
            <button
              key={board.id}
              type="button"
              role="menuitem"
              className="boards-switcher__item"
              aria-current={board.id === active.id}
              onClick={() => run(() => switchToBoard(board.id))}
            >
              <span className="boards-switcher__name">{board.name}</span>
              {board.id === active.id && <span aria-hidden="true">✓</span>}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="boards-switcher__item boards-switcher__item--new"
            onClick={() => run(createAndOpenBoard)}
          >
            + Nuevo tablero
          </button>
          {error && (
            <div className="boards-switcher__note boards-switcher__note--error">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
