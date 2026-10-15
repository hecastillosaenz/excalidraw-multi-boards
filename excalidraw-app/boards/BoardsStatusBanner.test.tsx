import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Provider, appJotaiStore } from "../app-jotai";

import * as persistence from "./boardPersistence";
import { BoardsStatusBanner } from "./BoardsStatusBanner";
import * as switching from "./boardSwitching";

vi.mock("./boardPersistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./boardPersistence")>()),
  saveLatestAsNewBoard: vi.fn(),
  discardUnsavedBoardEdits: vi.fn(),
}));
vi.mock("./boardSwitching", () => ({ switchToBoard: vi.fn() }));

// the app renders this inside <Provider store={appJotaiStore}>
const renderBanner = () =>
  render(
    <Provider store={appJotaiStore}>
      <BoardsStatusBanner />
    </Provider>,
  );

const setStatus = (status: persistence.BoardsStatus) =>
  appJotaiStore.set(persistence.boardsStatusAtom, status);

beforeEach(() => {
  vi.clearAllMocks();
  setStatus({ kind: "ok" });
});

describe("BoardsStatusBanner", () => {
  it("shows nothing when saving works", () => {
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("tells how to start the server when it is unreachable", () => {
    setStatus({ kind: "load-failed", detail: "HTTP 500", unreachable: true });
    renderBanner();
    expect(screen.getByRole("alert")).toHaveTextContent("yarn start:boards");
  });

  it("offers a way out of a conflict instead of just 'reload'", () => {
    setStatus({ kind: "conflict" });
    renderBanner();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "esta pestaña dejó de guardar",
    );
    expect(
      screen.getByRole("button", {
        name: "Guardar mis cambios como tablero nuevo",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Recargar este tablero" }),
    ).toBeEnabled();
  });

  it("keeps the user's work as a new board, then lets them open it", async () => {
    setStatus({ kind: "conflict" });
    vi.mocked(persistence.saveLatestAsNewBoard).mockResolvedValue({
      id: "copy-id",
      name: "Tablero 1 (copia de conflicto)",
    } as Awaited<ReturnType<typeof persistence.saveLatestAsNewBoard>>);
    renderBanner();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Guardar mis cambios como tablero nuevo",
      }),
    );

    expect(
      await screen.findByText(
        /se guardaron como «Tablero 1 \(copia de conflicto\)»/,
      ),
    ).toBeInTheDocument();
    // the edits are now safe, so leaving must not warn about them
    expect(persistence.discardUnsavedBoardEdits).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Abrir la copia" }));
    expect(switching.switchToBoard).toHaveBeenCalledWith("copy-id");
  });

  it("does not discard anything if the copy could not be saved", async () => {
    setStatus({ kind: "conflict" });
    vi.mocked(persistence.saveLatestAsNewBoard).mockRejectedValue(
      new Error("boom"),
    );
    renderBanner();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Guardar mis cambios como tablero nuevo",
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "No se pudo guardar la copia",
      ),
    );
    expect(persistence.discardUnsavedBoardEdits).not.toHaveBeenCalled();
    // and it can be retried
    expect(
      screen.getByRole("button", {
        name: "Guardar mis cambios como tablero nuevo",
      }),
    ).toBeEnabled();
  });
});
