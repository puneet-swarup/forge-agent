# Developing Forge Agent

## First-time setup

    git clone https://github.com/puneet-swarup/forge-agent
    cd forge-agent
    install.bat          # Windows
    ./install.sh         # macOS / Linux

`install.bat` / `install.sh` run `npm install`, download Chromium,
and link the CLI globally. They try `npm link` first (live edits) and
fall back to `npm install -g .` (copy mode) if linking isn't possible.

## Live-edit workflow on Windows

If `install.bat` reports "Installed in COPY mode", source edits will
not take effect until you re-run the script. Two ways to get live
edits — **pick whichever suits your machine**:

### Option 1 — Enable Developer Mode *(recommended)*
  1. Windows Settings → Privacy & Security → For developers
  2. Developer Mode = On
  3. Re-run `install.bat` — `npm link` will now succeed

### Option 2 — Move npm's global prefix to your user profile
If you cannot change Windows settings (e.g. corporate machine):

    npm config set prefix "%APPDATA%\npm"
    setx PATH "%PATH%;%APPDATA%\npm"

Then open a **new** terminal and re-run `install.bat`.

Neither option is required to *use* Forge Agent — they only affect
whether source edits are picked up immediately or on next reinstall.