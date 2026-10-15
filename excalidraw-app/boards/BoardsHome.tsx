import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BoardsApiError,
  BoardsUnreachableError,
  createBoard,
  deleteBoard,
  duplicateBoard,
  listBoards,
  renameBoard,
  thumbnailUrl,
} from "./boardsApi";
import { openBoardRoute } from "./boardsRoute";

import "./BoardsHome.scss";

import type { BoardListItem } from "./boardsApi";

type SortKey = "updated" | "created" | "name";
type ViewMode = "list" | "grid";

const SORTS: readonly SortKey[] = ["updated", "created", "name"];
const VIEWS: readonly ViewMode[] = ["list", "grid"];

const SORT_LABELS: Record<SortKey, string> = {
  updated: "Última modificación",
  created: "Fecha de creación",
  name: "Nombre (A–Z)",
};

const dateFormat = new Intl.DateTimeFormat("es", {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateFormat.format(date);
};

/** Accent- and case-insensitive text for searching. */
const normalize = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const sorters: Record<SortKey, (a: BoardListItem, b: BoardListItem) => number> =
  {
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    name: (a, b) =>
      a.name.localeCompare(b.name, "es", {
        numeric: true,
        sensitivity: "base",
      }),
  };

/** Per-viewer convenience (view / sort); works without storage. */
const usePersistedChoice = <T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
) => {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return allowed.includes(stored as T) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // not available: the choice just lasts for this visit
    }
  };
  return [value, update] as const;
};

/** Follows the editor's theme setting (stored by the app). */
const isDarkTheme = () => {
  try {
    const stored = localStorage.getItem("excalidraw-theme");
    if (stored === "dark") {
      return true;
    }
    if (stored === "system") {
      return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    }
  } catch {
    // fall through to light
  }
  return false;
};

const describeError = (error: unknown) =>
  error instanceof BoardsApiError
    ? error.message || error.code
    : error instanceof BoardsUnreachableError
    ? "El servidor de tableros no responde."
    : "Ocurrió un error inesperado.";

// ---------------------------------------------------------------------------
// icons (inline: the home screen doesn't load the editor's icon set)

const Icon = ({ path }: { path: string }) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
);

const ICONS = {
  plus: "M12 5v14M5 12h14",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  dots: "M12 5h.01M12 12h.01M12 19h.01",
  board: "M3 5h18v14H3zM7 15l3-4 3 3 2-2 3 3",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.5-4.5",
};

// ---------------------------------------------------------------------------

const Thumbnail = ({ board }: { board: BoardListItem }) => {
  const [failed, setFailed] = useState(false);
  return (
    <span className="boards-thumb">
      {board.hasThumbnail && !failed ? (
        <img
          src={thumbnailUrl(board.id, board.updatedAt)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="boards-thumb__placeholder">
          <Icon path={ICONS.board} />
        </span>
      )}
    </span>
  );
};

const RowMenu = ({
  board,
  onRename,
  onDuplicate,
  onDelete,
}: {
  board: BoardListItem;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
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

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="boards-menu" ref={rootRef}>
      <button
        type="button"
        className="boards-icon-button"
        aria-label={`Opciones de «${board.name}»`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon path={ICONS.dots} />
      </button>
      {open && (
        <div className="boards-menu__popup" role="menu">
          <button type="button" role="menuitem" onClick={choose(onRename)}>
            Cambiar nombre
          </button>
          <button type="button" role="menuitem" onClick={choose(onDuplicate)}>
            Duplicar
          </button>
          <button
            type="button"
            role="menuitem"
            className="boards-menu__danger"
            onClick={choose(onDelete)}
          >
            Eliminar…
          </button>
        </div>
      )}
    </div>
  );
};

const RenameField = ({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => Promise<void>;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const settled = useRef(false);

  const commit = async () => {
    if (settled.current) {
      return;
    }
    const name = value.trim();
    if (!name) {
      setError("El título no puede estar vacío.");
      return;
    }
    settled.current = true;
    if (name === initial) {
      onCancel();
      return;
    }
    try {
      await onCommit(name);
    } catch (e) {
      settled.current = false;
      setError(describeError(e));
    }
  };

  return (
    <span className="boards-rename">
      <input
        autoFocus
        aria-label="Título del tablero"
        value={value}
        maxLength={200}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            settled.current = true;
            onCancel();
          }
        }}
      />
      {error && (
        <span className="boards-rename__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
};

const ConfirmDelete = ({
  board,
  busy,
  onCancel,
  onConfirm,
}: {
  board: BoardListItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="boards-dialog-backdrop" onClick={onCancel}>
      <div
        className="boards-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="boards-delete-title"
        aria-describedby="boards-delete-text"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="boards-delete-title">¿Eliminar «{board.name}»?</h2>
        <p id="boards-delete-text">
          El tablero se moverá a la papelera (la carpeta <code>.trash</code>{" "}
          dentro de tu carpeta de tableros). No se borra de forma definitiva:
          puedes recuperarlo moviendo sus archivos de vuelta.
        </p>
        <div className="boards-dialog__actions">
          <button
            type="button"
            className="boards-button"
            autoFocus
            onClick={onCancel}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="boards-button boards-button--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Eliminando…" : "Eliminar"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------

/**
 * Boards home screen (F1–F6): every board with its title, creation date and
 * last modification, plus create / rename / duplicate / delete. Shown when the
 * URL has no `?board=`; the editor isn't even mounted behind it.
 */
export const BoardsHome = () => {
  const [boards, setBoards] = useState<BoardListItem[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = usePersistedChoice<SortKey>(
    "excalidraw-boards-home-sort",
    SORTS,
    "updated",
  );
  const [view, setView] = usePersistedChoice<ViewMode>(
    "excalidraw-boards-home-view",
    VIEWS,
    "list",
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BoardListItem | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setBoards(await listBoards());
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const previous = document.title;
    document.title = "Mis tableros";
    return () => {
      document.title = previous;
    };
  }, []);

  const visible = useMemo(() => {
    const needle = normalize(query.trim());
    return (boards ?? [])
      .filter((board) => !needle || normalize(board.name).includes(needle))
      .sort(sorters[sort]);
  }, [boards, query, sort]);

  /** Runs a mutation, refreshes the list, and reports failures. */
  const act = async (task: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const info = await task();
      await load();
      if (info) {
        setMessage({ kind: "info", text: info });
      }
    } catch (error) {
      setMessage({ kind: "error", text: describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    act(async () => {
      const { id } = await createBoard();
      openBoardRoute(id, "push"); // straight into the new board
    });

  const duplicate = (board: BoardListItem) =>
    act(async () => {
      const copy = await duplicateBoard(board.id);
      return `Se creó «${copy.name}».`;
    });

  const confirmDelete = async () => {
    if (!pendingDelete) {
      return;
    }
    const board = pendingDelete;
    await act(async () => {
      await deleteBoard(board.id);
      return `«${board.name}» se movió a la papelera.`;
    });
    setPendingDelete(null);
  };

  const rename = async (board: BoardListItem, name: string) => {
    await renameBoard(board.id, name); // errors surface inside the field
    setRenamingId(null);
    await load();
  };

  const open = (event: React.MouseEvent, board: BoardListItem) => {
    // let the browser handle "open in new tab" (ctrl/cmd/middle click)
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    openBoardRoute(board.id, "push");
  };

  const titleCell = (board: BoardListItem) =>
    renamingId === board.id ? (
      <RenameField
        initial={board.name}
        onCommit={(name) => rename(board, name)}
        onCancel={() => setRenamingId(null)}
      />
    ) : (
      <a
        className="boards-title"
        href={`?board=${board.id}`}
        onClick={(event) => open(event, board)}
        onDoubleClick={(event) => {
          event.preventDefault();
          setRenamingId(board.id);
        }}
        title={board.name}
      >
        {board.name}
      </a>
    );

  const menu = (board: BoardListItem) => (
    <RowMenu
      board={board}
      onRename={() => setRenamingId(board.id)}
      onDuplicate={() => duplicate(board)}
      onDelete={() => setPendingDelete(board)}
    />
  );

  const elementsLabel = (count: number) =>
    count === 1 ? "1 elemento" : `${count} elementos`;

  return (
    <div className={`boards-home${isDarkTheme() ? " boards-home--dark" : ""}`}>
      <main className="boards-home__inner">
        <header className="boards-home__header">
          <h1>Mis tableros</h1>
          <button
            type="button"
            className="boards-button boards-button--primary"
            onClick={create}
            disabled={busy || loadError !== null}
          >
            <Icon path={ICONS.plus} /> Crear nuevo
          </button>
        </header>

        {loadError !== null ? (
          <section className="boards-state" role="alert">
            <h2>
              {loadError instanceof BoardsUnreachableError
                ? "No se pudo conectar con el servidor de tableros"
                : "No se pudo cargar la lista de tableros"}
            </h2>
            <p>
              {loadError instanceof BoardsUnreachableError
                ? "Inicia el servidor de tableros y pulsa Reintentar. No se ha perdido nada: tus tableros siguen guardados en tu carpeta de datos."
                : describeError(loadError)}
            </p>
            <button type="button" className="boards-button" onClick={load}>
              Reintentar
            </button>
          </section>
        ) : boards === null ? (
          <p className="boards-state boards-state--quiet">Cargando tableros…</p>
        ) : (
          <>
            <div className="boards-toolbar">
              <label className="boards-search">
                <Icon path={ICONS.search} />
                <input
                  type="search"
                  placeholder="Buscar por nombre"
                  aria-label="Buscar por nombre"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label className="boards-select">
                <span>Ordenar por</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                >
                  {SORTS.map((key) => (
                    <option key={key} value={key}>
                      {SORT_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>
              <div
                className="boards-toolbar__views"
                role="group"
                aria-label="Vista"
              >
                <button
                  type="button"
                  className="boards-icon-button"
                  aria-label="Vista de cuadrícula"
                  aria-pressed={view === "grid"}
                  onClick={() => setView("grid")}
                >
                  <Icon path={ICONS.grid} />
                </button>
                <button
                  type="button"
                  className="boards-icon-button"
                  aria-label="Vista de lista"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  <Icon path={ICONS.list} />
                </button>
              </div>
            </div>

            <div className="boards-messages" role="status" aria-live="polite">
              {message && (
                <p className={`boards-message boards-message--${message.kind}`}>
                  {message.text}
                </p>
              )}
            </div>

            {boards.length === 0 ? (
              <section className="boards-state">
                <h2>Todavía no tienes tableros</h2>
                <p>Crea el primero para empezar a dibujar.</p>
                <button
                  type="button"
                  className="boards-button boards-button--primary"
                  onClick={create}
                  disabled={busy}
                >
                  <Icon path={ICONS.plus} /> Crear nuevo
                </button>
              </section>
            ) : visible.length === 0 ? (
              <section className="boards-state boards-state--quiet">
                <p>Ningún tablero coincide con «{query}».</p>
              </section>
            ) : view === "list" ? (
              <table className="boards-table">
                <thead>
                  <tr>
                    <th scope="col">Nombre</th>
                    <th scope="col">Creado</th>
                    <th scope="col">Última modificación</th>
                    <th scope="col">
                      <span className="boards-visually-hidden">Acciones</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((board) => (
                    <tr key={board.id}>
                      <td>
                        <div className="boards-namecell">
                          <Thumbnail board={board} />
                          <span className="boards-namecell__text">
                            {titleCell(board)}
                            <span className="boards-subtle">
                              {elementsLabel(board.elementCount)}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <time
                          dateTime={board.createdAt}
                          title={board.createdAt}
                        >
                          {formatDate(board.createdAt)}
                        </time>
                      </td>
                      <td>
                        <time
                          dateTime={board.updatedAt}
                          title={board.updatedAt}
                        >
                          {formatDate(board.updatedAt)}
                        </time>
                      </td>
                      <td className="boards-table__actions">{menu(board)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <ul className="boards-grid">
                {visible.map((board) => (
                  <li key={board.id} className="boards-card">
                    <a
                      className="boards-card__preview"
                      href={`?board=${board.id}`}
                      onClick={(event) => open(event, board)}
                      tabIndex={-1}
                      aria-hidden="true"
                    >
                      <Thumbnail board={board} />
                    </a>
                    <div className="boards-card__footer">
                      <div className="boards-card__text">
                        {titleCell(board)}
                        <span className="boards-subtle">
                          Modificado {formatDate(board.updatedAt)}
                        </span>
                        <span className="boards-subtle">
                          Creado {formatDate(board.createdAt)}
                        </span>
                      </div>
                      {menu(board)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>

      {pendingDelete && (
        <ConfirmDelete
          board={pendingDelete}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
};
