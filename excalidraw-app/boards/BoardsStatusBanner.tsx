import { useAtomValue } from "../app-jotai";

import { boardsStatusAtom } from "./boardPersistence";

import type { BoardsStatus } from "./boardPersistence";

const describe = (status: Exclude<BoardsStatus, { kind: "ok" }>) => {
  switch (status.kind) {
    case "load-failed":
      return status.unreachable
        ? "No se pudo cargar tu tablero: el servidor de tableros no responde.\n" +
            "Este lienzo está vacío y NO se guardará. Inicia el servidor y recarga.\n" +
            `(${status.detail})`
        : "No se pudo abrir este tablero.\n" +
            "Este lienzo está vacío y NO se guardará. Revisa la dirección (?board=) y recarga.\n" +
            `(${status.detail})`;
    case "offline":
      return (
        "Sin conexión con el servidor de tableros.\n" +
        "Tus cambios siguen en pantalla y se reintentará guardar solo. No cierres la pestaña."
      );
    case "conflict":
      return (
        "Este tablero se guardó desde otra pestaña.\n" +
        "Para no sobrescribirlo, esta pestaña dejó de guardar. Recarga la página."
      );
    case "rejected":
      return `El servidor rechazó el guardado: ${status.detail}`;
  }
};

/** Persistent, impossible-to-miss notice that saving to disk isn't working. */
export const BoardsStatusBanner = () => {
  const status = useAtomValue(boardsStatusAtom);
  if (status.kind === "ok") {
    return null;
  }
  return (
    <div className="alert alert--danger" role="alert">
      {describe(status)}
    </div>
  );
};
