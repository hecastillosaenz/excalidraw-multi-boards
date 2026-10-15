import { useEffect, useRef, useState } from "react";

import { appJotaiStore, useAtomValue } from "../app-jotai";

import { createAndOpenBoard, goToHome, switchToBoard } from "./boardSwitching";
import { listBoards, renameBoard } from "./boardsApi";
import { activeBoardAtom } from "./boardsRoute";

import type { BoardListItem } from "./boardsApi";

/**
 * Top-bar control (F7, F4): shows the open board's name and offers quick
 * actions: back to all boards, rename this one, jump to another, or create.
 * Rendered through the editor's official `renderTopLeftUI` slot. Managing
 * boards (dates, duplicate, delete) lives on the home screen.
 */
export const BoardSwitcher = () => {
  const active = useAtomValue(activeBoardAtom);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [boards, setBoards] = useState<BoardListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const renameSettled = useRef(false);

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
      setError("No se pudo completar la acción. Revisa el servidor.");
    }
  };

  const startRename = () => {
    renameSettled.current = false;
    setDraft(active.name);
    setOpen(false);
    setRenaming(true);
  };

  const finishRename = async (save: boolean) => {
    if (renameSettled.current) {
      return;
    }
    renameSettled.current = true;
    const name = draft.trim();
    setRenaming(false);
    if (!save || !name || name === active.name) {
      return;
    }
    try {
      const meta = await renameBoard(active.id, name);
      appJotaiStore.set(activeBoardAtom, { id: meta.id, name: meta.name });
    } catch (e) {
      console.error("[boards] rename failed:", e);
      setError("No se pudo cambiar el nombre.");
      setOpen(true);
    }
  };

  if (renaming) {
    return (
      <div className="boards-switcher">
        <input
          autoFocus
          className="boards-switcher__rename"
          aria-label="Nombre del tablero"
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => finishRename(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finishRename(true);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              finishRename(false);
            }
          }}
        />
      </div>
    );
  }

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
          <button
            type="button"
            role="menuitem"
            className="boards-switcher__item"
            onClick={() => run(goToHome)}
          >
            ← Todos los tableros
          </button>
          <button
            type="button"
            role="menuitem"
            className="boards-switcher__item"
            onClick={startRename}
          >
            Cambiar nombre
          </button>
          <div className="boards-switcher__separator" role="separator" />
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
