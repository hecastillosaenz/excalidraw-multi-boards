import { useState } from "react";

import { useAtomValue } from "../app-jotai";

import {
  boardsStatusAtom,
  discardUnsavedBoardEdits,
  saveLatestAsNewBoard,
} from "./boardPersistence";
import { switchToBoard } from "./boardSwitching";

import type { BoardsStatus } from "./boardPersistence";

type Problem = Exclude<BoardsStatus, { kind: "ok" | "conflict" }>;

const describe = (status: Problem) => {
  switch (status.kind) {
    case "load-failed":
      return status.unreachable
        ? "No se pudo cargar tu tablero: el servidor de tableros no responde.\n" +
            "Este lienzo está vacío y NO se guardará. Ejecuta «yarn start:boards» y recarga.\n" +
            `(${status.detail})`
        : "No se pudo abrir este tablero.\n" +
            "Este lienzo está vacío y NO se guardará. Revisa la dirección (?board=) y recarga.\n" +
            `(${status.detail})`;
    case "offline":
      return (
        "Sin conexión con el servidor de tableros.\n" +
        "Tus cambios siguen en pantalla y se reintentará guardar solo. No cierres la pestaña."
      );
    case "rejected":
      return `El servidor rechazó el guardado: ${status.detail}`;
  }
};

/**
 * Another tab saved this board first (409). This tab stopped saving so it
 * can't overwrite that work; here the user decides what to do with theirs.
 */
const ConflictBanner = () => {
  const [step, setStep] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; id: string; name: string }
    | { kind: "error" }
  >({ kind: "idle" });

  const keepMine = async () => {
    setStep({ kind: "saving" });
    try {
      const copy = await saveLatestAsNewBoard();
      discardUnsavedBoardEdits();
      setStep({ kind: "saved", id: copy.id, name: copy.name });
    } catch (error) {
      console.error("[boards] could not save the conflict copy:", error);
      setStep({ kind: "error" });
    }
  };

  return (
    <div className="alert alert--danger boards-banner" role="alert">
      {step.kind === "saved"
        ? `Tus cambios se guardaron como «${step.name}».\nYa puedes abrir esa copia o recargar este tablero.`
        : "Este tablero se guardó desde otra pestaña.\nPara no sobrescribirlo, esta pestaña dejó de guardar."}
      {step.kind === "error" && (
        <>{"\n"}No se pudo guardar la copia. Revisa el servidor y reintenta.</>
      )}
      <div className="boards-banner__actions">
        {step.kind === "saved" ? (
          <button type="button" onClick={() => switchToBoard(step.id)}>
            Abrir la copia
          </button>
        ) : (
          <button
            type="button"
            onClick={keepMine}
            disabled={step.kind === "saving"}
          >
            {step.kind === "saving"
              ? "Guardando…"
              : "Guardar mis cambios como tablero nuevo"}
          </button>
        )}
        <button type="button" onClick={() => window.location.reload()}>
          Recargar este tablero
        </button>
      </div>
    </div>
  );
};

/** Persistent, impossible-to-miss notice that saving to disk isn't working. */
export const BoardsStatusBanner = () => {
  const status = useAtomValue(boardsStatusAtom);
  if (status.kind === "ok") {
    return null;
  }
  if (status.kind === "conflict") {
    return <ConflictBanner />;
  }
  return (
    <div className="alert alert--danger" role="alert">
      {describe(status)}
    </div>
  );
};
