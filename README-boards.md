# Excalidraw con varios tableros (guardados en archivos)

Este fork de Excalidraw añade **varios tableros** con una pantalla de inicio (lista con título, fecha de creación y última modificación) y guarda cada tablero como **un archivo en una carpeta de tu disco**, no en el navegador.

Por eso cambiar de puerto, de navegador o borrar los datos del sitio **ya no afecta a tus tableros**.

## Cómo funciona

```
Navegador (puerto de Vite: 3001)      Servidor de tableros (127.0.0.1:3100)        Disco
┌──────────────────────────┐ /api    ┌─────────────────────────┐        ┌───────────────────────────┐
│ app de Excalidraw        │ ──────► │ boards-server/          │ ─────► │ carpeta de datos          │
│  inicio + editor         │ ◄────── │ API local, sin internet │ ◄───── │  <id>.excalidraw  (dibujo)│
└──────────────────────────┘         └─────────────────────────┘        │  <id>.meta.json   (título)│
                                                                        │  <id>.thumb.png (miniatura)│
                                                                        │  .trash/        (papelera)│
                                                                        └───────────────────────────┘
```

- El servidor solo escucha en `127.0.0.1` (tu máquina). Nada sale a internet.
- Un tablero es un archivo `.excalidraw` estándar, con las imágenes dentro. Se puede abrir en excalidraw.com con **Abrir**.

## Requisitos

- **Node 22.18 o superior** (el servidor ejecuta TypeScript directamente). Comprueba con `node -v`.
- **Yarn 1** (el del proyecto).

## Arrancar

```bash
yarn start:boards
```

Un solo comando: inicia el servidor de tableros, espera a que responda y después inicia la app (`yarn start`). **Ctrl-C detiene las dos cosas.**

- La app se abre en <http://localhost:3001> (el puerto de `.env.development`).
- Si ya hay un servidor de tableros en marcha en el puerto 3100, lo reutiliza.
- Si algo falla (por ejemplo, la carpeta de datos está mal), se niega a continuar y te dice por qué, en vez de abrir una app que no puede guardar.

> La primera vez, o si cambias de rama, `yarn start` ejecuta `yarn install` (es el comportamiento original del proyecto).

## Variables de entorno

| Variable | Para qué sirve | Por defecto |
| --- | --- | --- |
| `BOARDS_DIR` | Carpeta donde se guardan los tableros | `../data` (junto a la carpeta del proyecto) |
| `BOARDS_PORT` | Puerto del servidor de tableros | `3100` |
| `VITE_APP_PORT` | Puerto de la app (Vite) | `3001` |

Ejemplos:

```bash
# otra carpeta de datos (si es relativa, cuenta desde la raíz del proyecto)
BOARDS_DIR=/Users/yo/Dropbox/tableros yarn start:boards

# otro puerto para la app, sin tocar archivos versionados
echo "VITE_APP_PORT=3005" >> .env.development.local   # git lo ignora
yarn start:boards
```

**Regla de seguridad:** si `BOARDS_DIR` queda **dentro de un repositorio git**, el servidor se niega a arrancar. Los datos deben vivir fuera del código para que nunca se borren ni se suban por accidente.

## Usar los tableros

**Pantalla de inicio** (la que ves al abrir la app sin `?board=` en la dirección):

- **Crear nuevo**: crea un tablero ("Tablero N") y lo abre.
- **Abrir**: clic en el título (o Ctrl/Cmd + clic para abrirlo en otra pestaña).
- **⋮ → Cambiar nombre / Duplicar / Eliminar…** (también doble clic en el título para renombrar).
- **Eliminar** pide confirmación y **mueve el tablero a la papelera**, no lo borra de forma definitiva.
- **Importar…** (o arrastra archivos sobre la pantalla): cada `.excalidraw` se convierte en un tablero nuevo; el archivo original no se toca.
- **Buscar** por nombre (sin distinguir mayúsculas ni acentos), **ordenar** por modificación, creación o nombre, y cambiar entre **lista** y **cuadrícula**.

**Dentro de un tablero**, el botón con su nombre (arriba a la izquierda) permite volver a **Todos los tableros**, **cambiar el nombre**, saltar a otro tablero o crear uno nuevo. Al cambiar de tablero, el actual se guarda primero.

Los cambios se guardan solos (cada ~1 s sin tocar nada, y siempre al salir del tablero). El nombre del tablero se usa también como nombre de archivo al exportar imágenes.

## Copia de seguridad

Tus tableros son **la carpeta de datos**: cópiala y tienes todo.

```bash
# ejemplo con rsync (sirve para copias periódicas)
rsync -a ~/Projects/excalidraw/data/ ~/Backups/tableros/
```

- Los archivos se escriben de forma atómica (archivo temporal + renombrar), así que copiar con la app abierta es seguro. Aun así, lo ideal es copiar con la app cerrada.
- Puedes poner la carpeta de datos dentro de Dropbox, iCloud o similar (`BOARDS_DIR`). Úsala desde **una sola máquina a la vez**: no hay fusión de cambios entre dispositivos.
- Para **restaurar**, vuelve a copiar la carpeta en su sitio con la app cerrada.

## Recuperar un tablero eliminado (papelera)

Eliminar mueve los archivos a `.trash/` dentro de la carpeta de datos, con la fecha en el nombre:

```
.trash/<id>-<fecha>.excalidraw
.trash/<id>-<fecha>.meta.json
.trash/<id>-<fecha>.thumb.png      (si tenía miniatura)
```

Para recuperarlo, **con la app cerrada**, vuelve a mover sus archivos a la carpeta de datos **quitando la parte `-<fecha>`** del nombre. Este bucle lo hace por ti (funciona en zsh y bash, tenga o no miniatura):

```bash
cd ~/Projects/excalidraw/data                     # tu carpeta de datos
ID=0524e779-838d-43fe-9586-d6a140680d97          # el id del tablero (míralo en el nombre de los archivos de .trash)
for f in .trash/$ID-*; do mv "$f" "$(basename "$f" | sed -E "s/^($ID)-[0-9TZ]+/\1/")"; done
```

Al volver a arrancar, el tablero aparece de nuevo en la lista.

La app nunca vacía la papelera; puedes borrar su contenido a mano cuando quieras.

## Qué avisa la app y qué hacer

| Aviso | Significa | Qué hacer |
| --- | --- | --- |
| "No se pudo cargar tu tablero: el servidor no responde" | El servidor de tableros no está en marcha. El lienzo vacío **no** se guarda. | Ejecuta `yarn start:boards` y recarga. No se perdió nada. |
| "Sin conexión con el servidor de tableros" | El servidor se cayó mientras editabas. | Tus cambios siguen en pantalla y se reintenta solo. No cierres la pestaña; reinicia el servidor. |
| "Este tablero se guardó desde otra pestaña" | Editaste el mismo tablero en dos pestañas y la otra guardó primero. | **Guardar mis cambios como tablero nuevo** (no pierdes nada) o **Recargar**. |
| "El servidor rechazó el guardado" | Por ejemplo, el tablero supera 50 MB. | Reduce imágenes o divide el tablero. |

Al cerrar la pestaña con cambios aún sin confirmar en disco, el navegador te pregunta antes.

## Limitaciones conocidas

- **Colaboración en vivo y enlaces compartidos** (`#room=`, `#json=`, `#url=`) están desactivados en este modo.
- La **biblioteca de formas**, el **tema** (claro/oscuro), el **idioma** y los estilos de herramienta (color de trazo, etc.) siguen guardándose en el navegador y dependen del puerto: al cambiar de puerto vuelven a sus valores por defecto. **Los tableros no.**
- En **móvil** no aparece el botón del nombre del tablero (usa Atrás del navegador para volver al inicio). El uso previsto es de escritorio.
- Un tablero muy grande (decenas de MB de imágenes) se reescribe entero en cada guardado.

## Pruebas

```bash
yarn test:boards              # servidor de tableros (suite aparte)
yarn test:boards:typecheck    # tipos del servidor
yarn test:app --watch=false   # todo lo demás, incluida la capa de tableros
yarn test:typecheck           # tipos de la app
```

`yarn test:boards` es una suite aparte a propósito: la configuración de pruebas general asume un navegador simulado y no sirve para un servidor Node. Las pruebas del servidor usan carpetas temporales y **nunca tocan tu carpeta de datos**.

## Dónde está el código

| Qué | Dónde |
| --- | --- |
| Servidor de tableros (API, archivos, papelera) | `boards-server/` |
| Pantalla de inicio, guardado, cambio de tablero | `excalidraw-app/boards/` |
| Cambios mínimos en archivos originales | `excalidraw-app/App.tsx`, `excalidraw-app/data/LocalData.ts`, `excalidraw-app/vite.config.mts`, `package.json` |
| Diseño y decisiones | `docs/SDD-multi-boards.md` |

Todo cambio dentro de un archivo original está marcado con `// [boards]` para encontrarlo al resolver conflictos.

## Traer cambios del Excalidraw original (upstream)

Este fork está pensado para actualizarse con poco esfuerzo: casi todo el código nuevo está en carpetas propias y solo se tocan 4 archivos originales.

```bash
git remote -v                      # debe existir "upstream" -> excalidraw/excalidraw
git fetch upstream
git checkout master                # la rama principal de este fork ya incluye los tableros
git merge upstream/master          # o: git rebase upstream/master
```

1. Si hay **conflictos**, estarán en alguno de los 4 archivos de arriba o en `README.md`. En `README.md` conserva el README nuevo de upstream **debajo** y deja intacto el bloque propio del fork (entre `<!-- [boards] INICIO … -->` y `<!-- [boards] FIN … -->`). Busca `[boards]` en el archivo y conserva **ambos** lados: lo nuevo de upstream y los bloques `[boards]`.
2. `yarn install`
3. Comprueba que todo sigue bien:

   ```bash
   yarn test:typecheck && yarn test:app --watch=false && yarn test:boards
   ```

4. Comprueba que solo tocas lo permitido:

   ```bash
   git diff upstream/master --stat
   ```

   Debe mostrar únicamente los 4 archivos originales de la tabla anterior, `README.md` (solo el bloque que va entre los marcadores `[boards]` al principio), más las carpetas nuevas (`boards-server/`, `excalidraw-app/boards/`), este README y `docs/`.

5. Prueba a mano: `yarn start:boards`, abre un tablero con imágenes y vuelve al inicio.

Si upstream cambia a fondo cómo guarda datos `LocalData.ts` o cómo arranca `App.tsx`, revisa el apartado "Diseño" de `docs/SDD-multi-boards.md` (secciones 5.6 y 13) antes de resolver el conflicto.

## Problemas frecuentes

- **"Port 3100 is already in use"**: ya hay otro servidor de tableros (o algo más) en ese puerto. Cambia `BOARDS_PORT` o cierra el otro proceso.
- **"Refusing to start: BOARDS_DIR … is inside the git work tree"**: elige una carpeta fuera del repositorio.
- **Node demasiado viejo**: actualiza a Node 22.18+ (por ejemplo `nvm install 22`).
- **La app abre en un puerto distinto al esperado**: el 3001 estaba ocupado y Vite eligió otro. Tus tableros no cambian por eso.
