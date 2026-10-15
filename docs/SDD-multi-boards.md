# SDD — Multi-Board Excalidraw con persistencia en disco

> Documento de diseño para Claude Code. Léelo completo antes de tocar código.
> Estado: v1.0 · Autor: Helio "Besto" Castillo · Idioma de trabajo: español (código e identificadores en inglés).

---

## 0. Cómo trabajar con este documento (acuerdo de trabajo)

1. **Fase 0 es solo lectura.** No modifiques nada hasta entregar el informe de descubrimiento (sección 9) y recibir confirmación.
2. **Etiqueta lo que afirmas.** Distingue siempre: **[Verificado]** (lo leíste en el código o lo ejecutaste), **[Hipótesis]** (inferido, por confirmar) y **[Decisión]** (elegida en este documento). Si el código real contradice una hipótesis de aquí, detente, repórtalo y propón ajuste; no improvises en silencio.
3. **Commits pequeños**, uno por paso lógico, en la rama `feature/multi-boards`. Mensajes en inglés, formato `tipo: descripción`.
4. **Explica el porqué** de cada cambio no trivial en 2–4 líneas. El usuario está aprendiendo y quiere entender el diseño, no solo recibir código.
5. **Pregunta antes de salirte del alcance:** tocar archivos fuera de la lista de la sección 8, añadir dependencias, o cambiar una decisión de la sección 3.
6. **Nunca borres datos del usuario.** Ni su carpeta de tableros, ni su `localStorage` original. Borrar un tablero = mover a papelera (sección 5.4).
7. Entre fases hay **puertas de verificación (gates)**. No avances si el gate no pasa.

---

## 1. Contexto y problema

### 1.1 Qué es el proyecto
Fork local de [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) (licencia MIT). El usuario lo ejecuta en su máquina con `yarn start`. No usa excalidraw.com.

### 1.2 Problema
La app actual solo mantiene **un único tablero**. El usuario quiere conservar **todas** las funcionalidades del editor y añadir **múltiples tableros** con una experiencia tipo Miro: pantalla de inicio con tarjetas, crear, abrir, renombrar, duplicar y eliminar.

### 1.3 Problema secundario (decisivo para el diseño)
Hoy los datos viven en el navegador (`localStorage` + IndexedDB), que están **aislados por origen** (protocolo + dominio + puerto). Cambiar de puerto, de navegador o limpiar datos del sitio hace inaccesible (o destruye) el tablero. **El usuario rechaza explícitamente esa dependencia.** Por tanto la fuente de verdad debe ser **archivos en una carpeta del disco**.

### 1.4 Usuario y restricciones
- Uso **personal y local**, un solo usuario, una sola máquina.
- Quiere mantener el fork **actualizable** respecto al repo original (mínimo de cambios en archivos ajenos).
- Perfil técnico: estudiante de data science, cómodo con Python/Git; JS/TS en nivel intermedio. Valora entender el diseño.

---

## 2. Hechos verificados sobre el código base

Verificado leyendo `excalidraw-app/data/LocalData.ts` en la rama `master` del repo original:

- **[Verificado]** El guardado local vive en la clase estática `LocalData` con `save`, `flushSave`, `pauseSave`, `resumeSave`, `isSavePaused`.
- **[Verificado]** Elementos y appState se guardan en `localStorage` con dos claves tomadas de `STORAGE_KEYS` (`LOCAL_STORAGE_ELEMENTS`, `LOCAL_STORAGE_APP_STATE`), serializados con `JSON.stringify`. Elementos pasan por `getNonDeletedElements`; appState por `clearAppStateForLocalStorage`.
- **[Verificado]** Las imágenes (`BinaryFiles`) se guardan **aparte**, en IndexedDB (`createStore("files-db", "files-store")`, vía `idb-keyval`), gestionadas por `LocalFileManager extends FileManager`.
- **[Verificado]** `LocalFileManager.clearObsoleteFiles` **borra** de IndexedDB las imágenes que no están en el lienzo actual y cuyo `lastRetrieved` tiene más de 24 h. Con varios tableros esto destruiría imágenes de los demás.
- **[Verificado]** `_save` está envuelto en `debounce(..., SAVE_TO_LOCAL_STORAGE_TIMEOUT)`.
- **[Verificado]** `isSavePaused()` devuelve `true` si `document.hidden` o si hay un lock (`"collaboration"`).
- **[Verificado]** La biblioteca de formas se guarda en otro IndexedDB (`LibraryIndexedDBAdapter`), independiente de la escena.
- **[Verificado]** Se usa `updateBrowserStateVersion(STORAGE_KEYS.VERSION_DATA_STATE | VERSION_FILES)` para sincronizar pestañas (`tabSync`).

**[Hipótesis] por confirmar en Fase 0** (no las des por ciertas):
- Que la carga inicial de la escena ocurre en `excalidraw-app/App.tsx` (algo como `initializeScene`) leyendo vía `importFromLocalStorage` / `data/localStorage.ts`.
- Que el monorepo usa Yarn workspaces y que `yarn start` arranca Vite desde `excalidraw-app`, con puerto por defecto 3000 configurable por variable de entorno (`VITE_APP_PORT`).
- Que el editor expone `excalidrawAPI` con `updateScene`, `resetScene`, `addFiles`, `getSceneElements`, `getAppState`, `getFiles`.
- Que existe `serializeAsJSON` exportado desde `@excalidraw/excalidraw` y `exportToBlob`/`exportToCanvas` para miniaturas.
- La versión de Node exigida (campo `engines` de `package.json`).

---

## 3. Decisiones de arquitectura

| # | Decisión | Alternativas descartadas | Motivo |
|---|---|---|---|
| D1 | **Servidor Node local independiente** que lee/escribe archivos en una carpeta | File System Access API (solo Chromium, permisos por sesión, el handle vive en IndexedDB → vuelve a depender del origen); exportar/importar manual | Es la única opción que elimina la dependencia del navegador y del puerto |
| D2 | Un tablero = **un archivo `.excalidraw`** (`<id>.excalidraw`) con elementos, appState e **imágenes embebidas** (`files`) | Imágenes en depósito común; base de datos | Autocontenido, portable, abrible en excalidraw.com, evita que un tablero borre imágenes de otro |
| D3 | **Metadatos en sidecar** `<id>.meta.json` (nombre, fechas, conteo) + miniatura `<id>.thumb.png` | Un `index.json` central | Un índice central se desincroniza; el listado se calcula escaneando la carpeta |
| D4 | **Identificador** = UUID v4 (nombre de archivo); el **nombre visible** vive en meta | Nombre visible como nombre de archivo | Evita colisiones y caracteres inválidos al renombrar |
| D5 | **Eliminar = mover a `.trash/`** (nunca borrado definitivo desde la app) | `fs.unlink` | Seguridad ante errores; recuperable a mano |
| D6 | **Routing por query param** `?board=<id>`; sin param → pantalla de inicio | Hash (`#board=`) | El hash ya lo usa Excalidraw para colaboración (`#room=`) y enlaces compartidos (`#json=`); evitar colisión |
| D7 | **Proxy de Vite** `/api/boards` → `http://127.0.0.1:3100` | Fetch directo cross-origin con CORS | Mismo origen en dev: sin CORS, y el puerto del servidor no se filtra al código cliente |
| D8 | Puerto del servidor de datos **fijo** (3100, configurable por `BOARDS_PORT`), enlazado solo a `127.0.0.1` | Puerto aleatorio; `0.0.0.0` | Predecible y no expuesto a la red |
| D9 | Carpeta de datos **fuera del repo**: `BOARDS_DIR`; por defecto `../data` relativo a la raíz del repo, resuelto a ruta absoluta al arrancar (estructura `~/Projects/excalidraw/{app,data}`). Si la ruta resuelta queda dentro del árbol de git, el servidor se niega a arrancar | Dentro del repo | Separar código de datos; poder borrar/actualizar el repo sin riesgo |
| D10 | **Biblioteca de formas global** (se queda en IndexedDB en v1) | Por tablero | Comportamiento tipo Miro; fuera de alcance moverla (ver 11) |
| D11 | **Colaboración en vivo fuera de alcance**; en modo tablero queda sin uso | Soportar rooms | Es otro flujo; uso individual |
| D12 | Un solo comando para arrancar todo (`yarn start:boards` o equivalente) | Dos terminales manuales | Evita olvidar el servidor. Implementación libre (`concurrently` u otra), pero justifica la dependencia |

---

## 4. Requisitos

### 4.1 Funcionales (MUST)
- **F1** Pantalla de inicio con cuadrícula de tarjetas: miniatura, nombre, fecha de modificación.
- **F2** Crear tablero (nombre por defecto "Tablero N", editable).
- **F3** Abrir tablero con clic; la URL pasa a `?board=<id>`.
- **F4** Renombrar tablero (desde inicio y desde el editor).
- **F5** Duplicar tablero (copia completa, incluidas imágenes).
- **F6** Eliminar tablero con confirmación; va a `.trash/`.
- **F7** Dentro del editor: control en la barra superior con el nombre del tablero para volver al inicio y saltar a otro tablero.
- **F8** Guardado automático (debounce) del tablero abierto a disco.
- **F9** Al cambiar de tablero o volver al inicio: guardar inmediatamente (flush) el actual **antes** de cargar el otro. No se pierden trazos.
- **F10** **Todas las funcionalidades del editor intactas** (dibujo, imágenes, exportar, tema, biblioteca, atajos, etc.).
- **F11** ~~Migración desde el navegador~~ **Fuera de alcance**: el proyecto parte de cero y no hay datos previos que migrar. Si la carpeta de datos está vacía, la app muestra la pantalla de inicio vacía con "Nuevo tablero".

### 4.2 Funcionales (SHOULD)
- **S1** Miniaturas generadas al guardar (throttled, ~320 px de ancho).
- **S2** Detección de edición concurrente (dos pestañas): el servidor rechaza con `409` si el archivo cambió desde la última lectura del cliente (`baseUpdatedAt`); la UI avisa.
- **S3** Ordenar tarjetas por última modificación; búsqueda por nombre.
- **S4** Importar un `.excalidraw` existente como tablero nuevo.

### 4.3 No funcionales
- **N1 Integridad:** escritura **atómica** (archivo temporal + `rename`). Un corte durante el guardado no corrompe el tablero.
- **N2 Seguridad local:** servidor solo en `127.0.0.1`; `id` validado con regex UUID estricta; rechazar cualquier ruta que escape de `BOARDS_DIR` (path traversal); límite de tamaño del body (p. ej. 50 MB).
- **N3 Rendimiento:** guardado con debounce ≥ 1 s; no escribir si no hubo cambios; respetar `isSavePaused()` (pestaña oculta).
- **N4 Mantenibilidad del fork:** ver sección 8 (presupuesto de archivos ajenos tocados).
- **N5 Degradación clara:** si el servidor no responde, la UI muestra un aviso visible y **no descarta el trabajo**: mantiene el estado en memoria y reintenta; opcionalmente cae al guardado local original.

### 4.4 Fuera de alcance (v1)
Colaboración en tiempo real, sincronización entre dispositivos, autenticación/usuarios, versionado de tableros, carpetas/etiquetas, biblioteca por tablero, empaquetado como app de escritorio, despliegue en producción.

---

## 5. Diseño

### 5.1 Vista general

```
Navegador (Vite, puerto variable)          Servidor de tableros (127.0.0.1:3100)       Disco
┌──────────────────────────────┐  /api/boards  ┌──────────────────────────┐      ┌─────────────────────────┐
│ excalidraw-app               │ ───proxy────► │ boards-server/           │ ───► │ BOARDS_DIR (../data)    │
│  ├ editor (sin cambios)      │               │  REST + validación       │      │  <uuid>.excalidraw      │
│  ├ boards/ (NUEVO)           │ ◄──────────── │  escritura atómica       │ ◄─── │  <uuid>.meta.json       │
│  │   api, store, Home, Switch│               └──────────────────────────┘      │  <uuid>.thumb.png       │
│  └ LocalData.ts (adaptado)   │                                                  │  .trash/                │
└──────────────────────────────┘                                                  └─────────────────────────┘
```

### 5.2 Formato en disco

`<id>.excalidraw` — formato nativo de Excalidraw (compatible con abrirlo en excalidraw.com):
```json
{ "type": "excalidraw", "version": 2, "source": "excalidraw-boards-local",
  "elements": [...], "appState": {...}, "files": { "<fileId>": { "mimeType": "...", "id": "...", "dataURL": "data:...", "created": 0 } } }
```
Usar la serialización propia de Excalidraw (`serializeAsJSON` o equivalente que confirme Fase 0) para que el archivo sea idéntico al que produce "Guardar en disco".

`<id>.meta.json`:
```json
{ "id": "uuid", "name": "Tablero 1", "createdAt": "ISO-8601", "updatedAt": "ISO-8601", "elementCount": 42 }
```

### 5.3 API REST (JSON, prefijo `/api/boards`)

| Método y ruta | Cuerpo | Respuesta | Notas |
|---|---|---|---|
| `GET /api/health` | — | `{ ok: true, dir }` | Para que la UI detecte si el servidor está vivo |
| `GET /api/boards` | — | `[{id,name,createdAt,updatedAt,elementCount,hasThumbnail}]` | Escanea la carpeta; orden por `updatedAt` desc |
| `POST /api/boards` | `{ name?, scene? }` | `201` meta | Crea vacío o desde `scene` (migración/importación) |
| `GET /api/boards/:id` | — | escena completa | `404` si no existe |
| `PUT /api/boards/:id` | `{ scene, baseUpdatedAt? }` | meta nueva | `409` si `baseUpdatedAt` está desactualizado (S2). Escritura atómica |
| `PATCH /api/boards/:id` | `{ name }` | meta | Solo renombra |
| `POST /api/boards/:id/duplicate` | — | `201` meta | Copia archivo + meta; nombre "… (copia)" |
| `DELETE /api/boards/:id` | — | `204` | Mueve a `.trash/` con sufijo de fecha |
| `PUT /api/boards/:id/thumbnail` | PNG binario | `204` | Límite de tamaño pequeño |
| `GET /api/boards/:id/thumbnail` | — | `image/png` | `404` si no hay |

Errores: JSON `{ error: "codigo", message: "..." }` con estados HTTP correctos. `id` inválido → `400`.

### 5.4 Papelera
`DELETE` mueve `<id>.*` a `BOARDS_DIR/.trash/<id>-<timestamp>.*`. No hay endpoint de vaciado. El usuario recupera moviendo los archivos de vuelta.

### 5.5 Cliente: capa `excalidraw-app/boards/` (código nuevo)
- `boardsApi.ts` — cliente `fetch` tipado de la API.
- `boardsStore.ts` — estado de tableros (usa **Jotai**, ya presente en la app, `app-jotai`; confirma en Fase 0) y tablero activo (`?board=`).
- `BoardsHome.tsx` — pantalla de inicio (F1–F6).
- `BoardSwitcher.tsx` — control en la barra del editor (F7, F4).
- `thumbnail.ts` — genera PNG con la utilidad de exportación del editor (S1).

### 5.6 Cliente: adaptación del guardado/carga (cambios en archivos existentes)
- **Guardado:** `LocalData.save` deja de escribir en `localStorage`/IndexedDB y llama al adaptador de tableros (que serializa la escena y hace `PUT`), **manteniendo** el debounce, `flushSave`, `isSavePaused`. Conservar la firma pública de `LocalData` para minimizar cambios en `App.tsx`.
- **Carga inicial:** donde hoy se hace la carga desde local, leer `?board=` y, si hay, `GET /api/boards/:id` → `updateScene` + `addFiles`. Sin param, no se monta el editor: se muestra `BoardsHome`.
- **Cambio de tablero:** `flushSave()` → `await` PUT → actualizar `?board=` → cargar el nuevo. Reiniciar el historial (undo/redo) del editor para que no se mezclen tableros (verificar mecanismo en Fase 0: `resetScene`/`history.clear`).
- **Imágenes:** ya no se persisten en IndexedDB para la escena; viven en el archivo. **Desactivar o neutralizar `clearObsoleteFiles`** para el nuevo flujo (sección 2, riesgo R2).
- **Pestañas:** revisar `tabSync`/`updateBrowserStateVersion`; con persistencia en disco, la sincronización entre pestañas del mismo origen deja de ser fuente de verdad. Decidir en Fase 0 si se desactiva o se deja inerte.
- **Fallback:** si `GET /api/health` falla al arrancar, mostrar un aviso claro con instrucciones (arrancar el servidor); no mostrar un tablero vacío silenciosamente (riesgo de que el usuario crea que perdió datos).

### 5.7 Secuencias clave

**Abrir tablero:** clic en tarjeta → `?board=id` → `GET /:id` → `updateScene` + `addFiles` → editor listo.
**Autoguardado:** cambio en escena → `LocalData.save` (debounce) → si pestaña visible → `PUT /:id` con `baseUpdatedAt` → actualizar `updatedAt` local → (throttled) generar y subir miniatura.
**Cambiar de tablero:** `flushSave` → esperar PUT → navegar → cargar nuevo.

---

## 6. Riesgos

| ID | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | ~~Pérdida de datos en migración~~ | n/a | n/a | No aplica: proyecto desde cero, sin migración |
| R2 | `clearObsoleteFiles` borra imágenes de otros tableros | Alta si no se trata | Alto | Imágenes embebidas por tablero; neutralizar la rutina; prueba específica |
| R3 | Conflictos al sincronizar con upstream | Media | Medio | Presupuesto de archivos tocados (sec. 8); código nuevo aislado en `boards/` y `boards-server/` |
| R4 | Corrupción por escritura interrumpida | Baja | Alto | Escritura atómica (temp + rename) |
| R5 | Dos pestañas pisándose | Media | Medio | S2 (`409` + aviso); documentar "last write wins" si no se implementa |
| R6 | Guardados excesivos / archivos grandes por imágenes embebidas | Media | Medio | Debounce, no guardar sin cambios, límite de body, medir tamaños en pruebas |
| R7 | Mezcla de historial undo/redo entre tableros | Media | Medio | Reiniciar historial al cambiar |
| R8 | Colisión de routing con `#room=` / `#json=` | Baja | Medio | Usar query param (D6) |
| R9 | Hipótesis de Fase 0 resultan falsas | Media | Medio | Informe de descubrimiento obligatorio y gate |
| R10 | Servidor caído y el usuario ve "tablero vacío" | Media | Alto (percepción de pérdida) | Health check al arrancar + aviso explícito (N5) |

---

## 7. Plan por fases con puertas de verificación

### Fase 0 — Descubrimiento (solo lectura)
Entregable: informe (sección 9). **Gate:** el usuario confirma el informe.

### Fase 1 — Línea base
- Rama `feature/multi-boards`; `yarn install`; `yarn start` funciona; la app abre.
- Confirmar versión de Node/Yarn contra `engines`.
**Gate:** app original corriendo sin cambios; commit vacío de referencia.

### Fase 2 — Servidor de tableros aislado
- `boards-server/` con la API de 5.3, validación y escritura atómica (N1, N2).
- Pruebas automáticas del servidor (crear, leer, guardar, renombrar, duplicar, borrar→papelera, id inválido, path traversal, `409`).
**Gate:** suite verde; la carpeta de datos se crea fuera del repo y refleja las operaciones.

### Fase 3 — Un solo tablero persistido en disco (prueba de concepto crítica)
- Proxy de Vite; adaptador de guardado detrás de `LocalData`; carga inicial desde servidor para un tablero fijo.
**Gate (el más importante):** dibujar con imágenes → cerrar → **cambiar el puerto del dev server** → reabrir → el tablero está intacto. Si esto falla, no se avanza.

### Fase 4 — Multi-tablero en la capa de datos + switcher
- `boardsStore`, `?board=`, `BoardSwitcher`, flush al cambiar, reinicio de historial, neutralizar `clearObsoleteFiles`.
**Gate:** dos tableros con imágenes distintas; alternar 10 veces; ningún trazo ni imagen se pierde ni se mezcla.

### Fase 5 — Pantalla de inicio estilo Miro
- `BoardsHome` con tarjetas, crear/renombrar/duplicar/eliminar, miniaturas (S1), búsqueda/orden (S3).
**Gate:** todos los criterios F1–F7 y F10 de la sección 10.

### Fase 6 — Endurecimiento y documentación
- S2, N5, importación (S4), script único de arranque (D12), `README-boards.md` con uso, variables de entorno, copia de seguridad y sincronización con upstream.
**Gate:** checklist de aceptación completa (sección 10).

---

## 8. Presupuesto de cambios en archivos existentes (mantenibilidad del fork)

**Código nuevo (sin conflictos con upstream):** `boards-server/**`, `excalidraw-app/boards/**`, `README-boards.md`, `docs/**`.

**Archivos existentes que se permite modificar (la lista completa; cualquier otro requiere preguntar):**
1. `excalidraw-app/data/LocalData.ts` — redirigir persistencia.
2. `excalidraw-app/App.tsx` — carga inicial, montaje de `BoardsHome`/`BoardSwitcher`.
3. `excalidraw-app/vite.config.mts` — proxy de `/api/boards`.
4. `package.json` (raíz) — script de arranque combinado y, si hace falta, una dependencia de desarrollo.

Regla: dentro de esos archivos, cambios **mínimos y localizados**, con comentario `// [boards]` en cada bloque tocado para localizarlos al resolver conflictos. No reformatear ni reordenar código ajeno.

---

## 9. Informe de Fase 0 (qué debes entregar antes de escribir código)

1. Estructura del monorepo (workspaces, scripts de `package.json`, versión de Node requerida).
2. **Puntos exactos** (archivo y función) donde se: a) llama a `LocalData.save`; b) carga la escena inicial; c) lee `localStorage`/IndexedDB al arrancar; d) usa `flushSave`/`pauseSave`/`resumeSave`.
3. Valores de `STORAGE_KEYS` y de `SAVE_TO_LOCAL_STORAGE_TIMEOUT`.
4. API del editor disponible (`excalidrawAPI`): confirmación de `updateScene`, `resetScene`, `addFiles`, `getSceneElements`, `getAppState`, `getFiles`; cómo limpiar el historial.
5. Funciones de serialización y exportación a imagen realmente exportadas por el paquete.
6. Qué hace `tabSync` y cómo interactúa con el nuevo flujo.
7. Dónde se monta la UI superior del editor (para el `BoardSwitcher`) y qué mecanismo oficial hay para inyectar UI (p. ej. `renderTopRightUI`, slots de `MainMenu`) — usar el mecanismo oficial antes que parchear componentes internos.
8. Si Jotai (`app-jotai`) es el mecanismo de estado apropiado.
9. Lista de **hipótesis de la sección 2 confirmadas o refutadas**, y cualquier hallazgo que cambie una decisión (con propuesta).

---

## 10. Criterios de aceptación (checklist final)

- [ ] Cambiar el puerto del dev server o de navegador **no** afecta a los tableros.
- [ ] Reiniciar la máquina y volver a abrir conserva todo.
- [ ] Crear, renombrar, duplicar y eliminar funcionan desde la pantalla de inicio; eliminar deja el archivo en `.trash/`.
- [ ] Alternar entre tableros nunca pierde trazos ni mezcla imágenes (probado con ≥ 3 tableros con imágenes).
- [ ] Las funcionalidades originales del editor siguen operativas (dibujo, texto, imágenes, exportar PNG/SVG, tema oscuro, biblioteca, atajos, deshacer/rehacer por tablero).
- [ ] Un tablero guardado se abre en excalidraw.com vía "Abrir" (formato nativo).
- [ ] Servidor caído → aviso claro, sin pérdida de trabajo en memoria.
- [ ] Suite de pruebas del servidor en verde; pruebas manuales del gate de cada fase documentadas.
- [ ] `git diff upstream/master --stat` toca únicamente los archivos permitidos en la sección 8 más el código nuevo.
- [ ] `README-boards.md` explica arranque, variables de entorno, copia de seguridad y cómo traer cambios de upstream.

---

## 11. Preguntas abiertas / decisiones futuras (no bloquean v1)

- Biblioteca de formas en disco (hoy depende del origen del navegador).
- Empaquetado como app de escritorio (Tauri/Electron) para eliminar el servidor aparte.
- Versionado/historial de tableros y sincronización entre dispositivos (p. ej. la carpeta dentro de Dropbox/Drive).
- Estructura de carpetas/etiquetas para organizar tableros.

---

## 12. Glosario

- **Escena:** `{ elements, appState, files }` del editor.
- **Origen (web):** protocolo + dominio + puerto; delimita el almacenamiento del navegador.
- **Flush:** forzar el guardado pendiente sin esperar el debounce.
- **Gate:** condición verificable que debe cumplirse antes de pasar a la siguiente fase.
- **Upstream:** repositorio original `excalidraw/excalidraw`.
