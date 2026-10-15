import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { appJotaiStore } from "../app-jotai";

import { BoardsHome } from "./BoardsHome";
import * as api from "./boardsApi";
import { BoardsApiError, BoardsUnreachableError } from "./boardsApi";
import { boardRouteAtom, getActiveBoardId } from "./boardsRoute";

vi.mock("./boardsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./boardsApi")>()),
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  renameBoard: vi.fn(),
  duplicateBoard: vi.fn(),
  deleteBoard: vi.fn(),
}));

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(
    3,
  )}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

const board = (
  n: number,
  name: string,
  createdAt: string,
  updatedAt: string,
  extra: Partial<api.BoardListItem> = {},
): api.BoardListItem => ({
  id: id(n),
  name,
  createdAt,
  updatedAt,
  elementCount: n,
  hasThumbnail: false,
  ...extra,
});

// created order: Ñandú < Árbol < Zeta ; modified order: Zeta < Ñandú < Árbol
const BOARDS = [
  board(1, "Ñandú", "2026-01-10T10:00:00.000Z", "2026-03-02T10:00:00.000Z"),
  board(2, "Árbol", "2026-02-10T10:00:00.000Z", "2026-04-05T10:00:00.000Z", {
    hasThumbnail: true,
  }),
  board(3, "Zeta", "2026-03-10T10:00:00.000Z", "2026-03-01T10:00:00.000Z"),
];

const titles = () =>
  screen
    .getAllByRole("link")
    .map((a) => a.textContent)
    .filter(Boolean);

const renderHome = async (list = BOARDS) => {
  vi.mocked(api.listBoards).mockResolvedValue(list);
  const view = render(<BoardsHome />);
  await screen.findByText(/Mis tableros/);
  if (list.length) {
    await screen.findByText(list[0].name);
  }
  return view;
};

const openMenuOf = (name: string) =>
  fireEvent.click(
    screen.getByRole("button", { name: `Opciones de «${name}»` }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  appJotaiStore.set(boardRouteAtom, { status: "home" });
});

describe("list view (default)", () => {
  it("shows each board's title, creation date and last modification", async () => {
    await renderHome();

    for (const header of ["Nombre", "Creado", "Última modificación"]) {
      expect(
        screen.getByRole("columnheader", { name: header }),
      ).toBeInTheDocument();
    }
    const rows = screen.getAllByRole("row").slice(1); // minus the header
    expect(rows).toHaveLength(3);

    const arbol = rows.find((r) => within(r).queryByText("Árbol"))!;
    const times = within(arbol).getAllByText(/2026/);
    expect(times).toHaveLength(2);
    expect(times[0]).toHaveAttribute("datetime", "2026-02-10T10:00:00.000Z");
    expect(times[1]).toHaveAttribute("datetime", "2026-04-05T10:00:00.000Z");
    expect(within(arbol).getByText("2 elementos")).toBeInTheDocument();
  });

  it("orders by last modification by default and can order by creation or name", async () => {
    await renderHome();
    expect(titles()).toEqual(["Árbol", "Ñandú", "Zeta"]); // newest edit first

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "created" },
    });
    expect(titles()).toEqual(["Zeta", "Árbol", "Ñandú"]); // newest created first

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "name" },
    });
    expect(titles()).toEqual(["Árbol", "Ñandú", "Zeta"]); // A–Z, accents sane
  });

  it("filters by name ignoring case and accents", async () => {
    await renderHome();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arbol" },
    });
    expect(titles()).toEqual(["Árbol"]);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "nada que ver" },
    });
    expect(screen.getByText(/Ningún tablero coincide/)).toBeInTheDocument();
  });

  it("remembers the chosen view and order for next time", async () => {
    const { unmount } = await renderHome();
    fireEvent.click(
      screen.getByRole("button", { name: "Vista de cuadrícula" }),
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "name" },
    });
    unmount();

    await renderHome();
    expect(
      screen.getByRole("button", { name: "Vista de cuadrícula" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox")).toHaveValue("name");
  });
});

describe("grid view", () => {
  it("shows cards with the title and both dates, and a thumbnail when present", async () => {
    await renderHome();
    fireEvent.click(
      screen.getByRole("button", { name: "Vista de cuadrícula" }),
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByText(/^Modificado /)).toHaveLength(3);
    expect(screen.getAllByText(/^Creado /)).toHaveLength(3);

    const imgs = document.querySelectorAll("img");
    expect(imgs).toHaveLength(1); // only "Árbol" has one
    expect(imgs[0].getAttribute("src")).toContain(
      `/api/boards/${id(2)}/thumbnail`,
    );
  });
});

describe("opening and creating", () => {
  it("opens a board when its title is clicked", async () => {
    await renderHome();
    fireEvent.click(screen.getByRole("link", { name: "Zeta" }));
    expect(getActiveBoardId()).toBe(id(3));
    expect(window.location.search).toBe(`?board=${id(3)}`);
  });

  it("leaves ctrl/cmd-click to the browser (open in a new tab)", async () => {
    await renderHome();
    fireEvent.click(screen.getByRole("link", { name: "Zeta" }), {
      ctrlKey: true,
    });
    expect(getActiveBoardId()).toBeNull();
  });

  it("'Crear nuevo' creates a board and goes straight into it", async () => {
    vi.mocked(api.createBoard).mockResolvedValue({
      id: id(9),
      name: "Tablero 4",
      createdAt: "x",
      updatedAt: "x",
      elementCount: 0,
    });
    await renderHome();
    fireEvent.click(screen.getAllByRole("button", { name: /Crear nuevo/ })[0]);
    await waitFor(() => expect(getActiveBoardId()).toBe(id(9)));
  });

  it("explains an empty folder and offers to create the first board", async () => {
    await renderHome([]);
    expect(screen.getByText("Todavía no tienes tableros")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Crear nuevo/ }).length,
    ).toBeGreaterThan(0);
  });
});

describe("rename", () => {
  it("renames from the row menu, trimming the title", async () => {
    vi.mocked(api.renameBoard).mockResolvedValue({} as api.BoardMeta);
    await renderHome();
    openMenuOf("Zeta");
    fireEvent.click(screen.getByRole("menuitem", { name: "Cambiar nombre" }));

    const input = screen.getByRole("textbox", { name: "Título del tablero" });
    fireEvent.change(input, { target: { value: "  Mi proyecto  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(api.renameBoard).toHaveBeenCalledWith(id(3), "Mi proyecto"),
    );
    // list is refreshed afterwards
    await waitFor(() => expect(api.listBoards).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole("textbox", { name: "Título del tablero" }),
    ).not.toBeInTheDocument();
  });

  it("also renames by double-clicking the title", async () => {
    await renderHome();
    fireEvent.doubleClick(screen.getByRole("link", { name: "Zeta" }));
    expect(
      screen.getByRole("textbox", { name: "Título del tablero" }),
    ).toHaveValue("Zeta");
  });

  it("refuses an empty title without calling the server", async () => {
    await renderHome();
    fireEvent.doubleClick(screen.getByRole("link", { name: "Zeta" }));
    const input = screen.getByRole("textbox", { name: "Título del tablero" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/vacío/);
    expect(api.renameBoard).not.toHaveBeenCalled();
  });

  it("Escape cancels, and a server error is shown in the field", async () => {
    vi.mocked(api.renameBoard).mockRejectedValue(
      new BoardsApiError(400, "invalid_name", "Name must be 1-200 characters."),
    );
    await renderHome();

    fireEvent.doubleClick(screen.getByRole("link", { name: "Zeta" }));
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Título del tablero" }),
      { key: "Escape" },
    );
    expect(api.renameBoard).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByRole("link", { name: "Zeta" }));
    const input = screen.getByRole("textbox", { name: "Título del tablero" });
    fireEvent.change(input, { target: { value: "Otro" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name must be 1-200 characters.",
    );
  });
});

describe("duplicate", () => {
  it("duplicates from the menu, refreshes and says what was created", async () => {
    vi.mocked(api.duplicateBoard).mockResolvedValue({
      name: "Zeta (copia)",
    } as api.BoardMeta);
    await renderHome();
    openMenuOf("Zeta");
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicar" }));

    await waitFor(() => expect(api.duplicateBoard).toHaveBeenCalledWith(id(3)));
    expect(
      await screen.findByText("Se creó «Zeta (copia)»."),
    ).toBeInTheDocument();
    expect(api.listBoards).toHaveBeenCalledTimes(2);
  });
});

describe("delete", () => {
  it("asks first, explains it goes to the trash, and only then deletes", async () => {
    vi.mocked(api.deleteBoard).mockResolvedValue(null);
    await renderHome();
    openMenuOf("Zeta");
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar…" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/¿Eliminar «Zeta»\?/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/papelera/);
    expect(api.deleteBoard).not.toHaveBeenCalled(); // nothing yet

    fireEvent.click(within(dialog).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(api.deleteBoard).toHaveBeenCalledWith(id(3)));
    expect(
      await screen.findByText("«Zeta» se movió a la papelera."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does nothing when cancelled (button or Escape)", async () => {
    await renderHome();
    openMenuOf("Zeta");
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    openMenuOf("Zeta");
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar…" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    expect(api.deleteBoard).not.toHaveBeenCalled();
  });

  it("reports a failed delete and keeps the board listed", async () => {
    vi.mocked(api.deleteBoard).mockRejectedValue(
      new BoardsUnreachableError("HTTP 500"),
    );
    await renderHome();
    openMenuOf("Zeta");
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar…" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Eliminar",
      }),
    );
    expect(
      await screen.findByText("El servidor de tableros no responde."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zeta" })).toBeInTheDocument();
  });
});

describe("server problems", () => {
  it("explains that nothing is lost and lets the user retry", async () => {
    vi.mocked(api.listBoards).mockRejectedValueOnce(
      new BoardsUnreachableError("HTTP 500"),
    );
    render(<BoardsHome />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/No se pudo conectar con el servidor/);
    expect(alert).toHaveTextContent(/No se ha perdido nada/);
    // no way to create while we can't reach the server
    expect(screen.getByRole("button", { name: /Crear nuevo/ })).toBeDisabled();

    vi.mocked(api.listBoards).mockResolvedValue(BOARDS);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Árbol")).toBeInTheDocument();
  });
});
