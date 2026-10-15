import { useI18n } from "@excalidraw/excalidraw/i18n";
import { WelcomeScreen } from "@excalidraw/excalidraw/index";
import React from "react";

/**
 * Replaces the app's welcome text, which says drawings live "in your
 * browser's storage" and "can be cleared unexpectedly": not true any more,
 * boards are files in the user's boards folder. Kept in `boards/` so the
 * upstream component stays untouched.
 */
export const BoardsWelcomeScreen = React.memo(() => {
  const { t } = useI18n();
  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint>
        {t("welcomeScreen.app.menuHint")}
      </WelcomeScreen.Hints.MenuHint>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo />
        <WelcomeScreen.Center.Heading>
          Este tablero se guarda como un archivo en tu carpeta de tableros.
          <br />
          Puedes cerrar el navegador o cambiar de puerto sin perderlo.
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          <WelcomeScreen.Center.MenuItemLoadScene />
          <WelcomeScreen.Center.MenuItemHelp />
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
});
