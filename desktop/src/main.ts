// ─────────────────────────────────────────────────────────────────────────────
// main.ts — the shell: one owned window, one bridge, one LCU poller.
//
// The whole reason this exists: `Start-Process` (open a browser tab and hope)
// becomes `window.loadURL` (navigate a window we own). Everything the companion
// needed to reason about an unowned browser — the 150s attach window, the open
// grace, the detach beacon, the browser-process probe — is not ported here,
// because none of it has anything to model.
//
// What it is NOT allowed to become: a fork of the web app. The window loads the
// live site; all product UI ships from Vercel. The only native surfaces are
// this window's chrome, the tray, and the overlay window — and even the overlay
// renders a normal web route (/compact) so browser users get it too.
// ─────────────────────────────────────────────────────────────────────────────
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session as electronSession, shell } from "electron";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { APP_ORIGIN, detectForeignBridge, startBridge, type BridgeState } from "./bridge";
import {
  discoverCredentials,
  lcuRequest,
  readChampSelect,
  resolveChampionId,
} from "./lcu";

const SHELL_VERSION = "0.1.0";
const POLL_MS = 1500;

// The shell mints its OWN token and never touches companion.ps1's persisted
// one. A shared token would let a plain browser tab cross-pair with the shell's
// bridge, which is exactly the coexistence confusion we are trying to end.
const SESSION_TOKEN = randomBytes(24).toString("hex");

const state: BridgeState = {
  version: SHELL_VERSION,
  session: SESSION_TOKEN,
  phase: "None",
  credentials: null,
  champSelect: null,
  lastOpen: null,
  lastPollAt: null,
  lastError: null,
};

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastOpenedChampionId = 0;
let wasChampSelect = false;

const appUrl = (pathname: string, params: Record<string, string> = {}): string => {
  const url = new URL(pathname, APP_ORIGIN);
  url.searchParams.set("session", SESSION_TOKEN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

// ── Windows ─────────────────────────────────────────────────────────────────

const baseWebPreferences = {
  // Remote content gets zero Node. A compromised page in here holds exactly
  // what a compromised tab in Chrome holds today: the session token, and with
  // it the four token-gated endpoints — which the bridge's own title gates
  // already bound to CoachBuild-titled writes.
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
  preload: path.join(__dirname, "preload.js"),
  // THE flag the whole premise rests on. Electron bundles the same Chromium
  // that throttles hidden-tab timers to ~1/min — the exact behaviour that
  // forced AttachWindowSeconds to 150. The window is minimised or fully
  // occluded for most of a game, and the page's own 3s /status poll is what
  // drives live-follow and auto-export. Without this line the shell reproduces
  // the bug it was built to kill.
  backgroundThrottling: false,
} as const;

const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: "#0a0d0b", // --bg, so there is no white flash before paint
    title: "CoachBuild",
    webPreferences: baseWebPreferences,
  });

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });

  // Total network failure gets a local retry screen instead of Chromium's
  // default error page. This is shell chrome, not app UI, so it may live here.
  window.webContents.on("did-fail-load", (_event, _code, description, failingUrl, isMainFrame) => {
    if (!isMainFrame) return;
    state.lastError = `load failed: ${description}`;
    window.loadFile(path.join(__dirname, "..", "static", "offline.html"), {
      query: { url: failingUrl, reason: description },
    });
  });

  void window.loadURL(appUrl("/"));
  return window;
};

/** The overlay renders /compact — a normal web route, so it updates with every
 *  web deploy and browser users can pop it out on a second monitor. The shell
 *  contributes the window behaviour (small, always-on-top, champ-select-only),
 *  which is the part a browser genuinely cannot do. */
const createOverlayWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 380,
    height: 620,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#0a0d0b",
    title: "CoachBuild — champ select",
    webPreferences: baseWebPreferences,
  });

  window.setAlwaysOnTop(true, "floating");
  window.on("closed", () => {
    overlayWindow = null;
  });
  void window.loadURL(appUrl("/compact"));
  return window;
};

const showOverlay = (championId: number, roleId: number | null): void => {
  if (!overlayWindow) overlayWindow = createOverlayWindow();
  const params: Record<string, string> = { championId: String(championId) };
  if (roleId != null) params.role = String(roleId);
  void overlayWindow.loadURL(appUrl("/compact", params));
  overlayWindow.showInactive(); // never steal focus from champ select
};

const hideOverlay = (): void => {
  overlayWindow?.hide();
};

// ── Security: navigation + permissions ──────────────────────────────────────

const lockDownNavigation = (): void => {
  const isOurs = (target: string): boolean => {
    try {
      return new URL(target).origin === APP_ORIGIN;
    } catch {
      return false;
    }
  };

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, target) => {
      if (!isOurs(target)) {
        event.preventDefault();
        void shell.openExternal(target);
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  // Chromium gates https -> 127.0.0.1 behind Local Network Access, the same
  // gate companionClient.ts classifies as `lna-denied` in a browser. In Electron
  // there is no permission UI to click, so an un-granted request just fails and
  // the shell would reproduce the exact failure it exists to escape. Grant that
  // one permission to our own origin; deny everything else by default.
  const allowed = new Set(["local-network-access"]);
  electronSession.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const origin = contents.getURL().startsWith(APP_ORIGIN);
    callback(origin && allowed.has(permission as string));
  });
  electronSession.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => {
    return origin === APP_ORIGIN && allowed.has(permission as string);
  });
};

// ── LCU poll ────────────────────────────────────────────────────────────────

const tick = async (): Promise<void> => {
  state.lastPollAt = new Date().toISOString();

  if (!state.credentials) {
    state.credentials = await discoverCredentials();
  }

  if (!state.credentials) {
    state.phase = "None";
    state.champSelect = null;
    return;
  }

  const phaseResponse = await lcuRequest<string>(state.credentials, "GET", "/lol-gameflow/v1/gameflow-phase");
  if (!phaseResponse.ok) {
    // 0 (socket dead) or 401 (rotated token) means the cached credentials are
    // gone — drop them so the next tick rediscovers, instead of hammering a
    // dead port every 1.5s until someone notices.
    if (phaseResponse.status === 0 || phaseResponse.status === 401) state.credentials = null;
    return;
  }

  const phase = typeof phaseResponse.body === "string" ? phaseResponse.body : String(phaseResponse.body ?? "None");
  state.phase = phase;

  if (phase !== "ChampSelect") {
    if (wasChampSelect) hideOverlay();
    wasChampSelect = false;
    state.champSelect = null;
    lastOpenedChampionId = 0;
    return;
  }

  if (!wasChampSelect) {
    // Champ-select ENTRY. In the browser this is where the companion opened two
    // tabs and hoped. Here the window already exists and is already on the app,
    // so this is a navigation inside a booted SPA — never a cold start.
    wasChampSelect = true;
    lastOpenedChampionId = 0;
    mainWindow?.showInactive();
  }

  const sessionResponse = await lcuRequest(state.credentials, "GET", "/lol-champ-select/v1/session");
  if (!sessionResponse.ok) {
    if (sessionResponse.status === 0 || sessionResponse.status === 401) state.credentials = null;
    return;
  }

  const snapshot = readChampSelect(sessionResponse.body);
  state.champSelect = snapshot;

  const championId = resolveChampionId(snapshot);
  if (championId <= 0 || championId === lastOpenedChampionId) return;

  lastOpenedChampionId = championId;
  state.lastOpen = { championId, roleId: snapshot?.roleId ?? null, at: new Date().toISOString() };

  // The window follows the hover in place. No tab is opened, so there is
  // nothing to spam and nothing to attach to.
  const params: Record<string, string> = { championId: String(championId) };
  if (snapshot?.roleId != null) params.role = String(snapshot.roleId);
  void mainWindow?.loadURL(appUrl("/", params));
  showOverlay(championId, snapshot?.roleId ?? null);
};

// ── Tray ────────────────────────────────────────────────────────────────────

const buildTray = (): void => {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("CoachBuild");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open CoachBuild", click: () => mainWindow?.show() },
      { label: "Show champ-select overlay", click: () => overlayWindow?.showInactive() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => mainWindow?.show());
};

// ── Lifecycle ───────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  void app.whenReady().then(async () => {
    lockDownNavigation();

    // Two companions on one machine both auto-apply — two racing whole-object
    // PUTs on the item-sets endpoint — and the PowerShell one still opens
    // browser tabs on champ select, which is the tab spam this app exists to
    // end, arriving by another route. Surface it rather than half-working.
    const foreign = await detectForeignBridge();
    if (foreign != null) {
      dialog.showMessageBoxSync({
        type: "warning",
        title: "CoachBuild companion is already running",
        message: "The PowerShell companion is running on this PC.",
        detail:
          `Something is already answering on 127.0.0.1:${foreign}. Running both means two processes ` +
          "writing rune pages and item sets at once, and the tray script will still open browser tabs " +
          "during champ select.\n\nQuit the tray companion (right-click its icon → Exit), then restart CoachBuild.",
        buttons: ["Continue anyway", "Quit"],
        defaultId: 1,
        cancelId: 1,
      }) === 1 && app.quit();
    }

    const bridge = await startBridge(state);
    console.log(`[coachbuild] bridge on 127.0.0.1:${bridge.port}`);

    mainWindow = createMainWindow();
    buildTray();

    setInterval(() => void tick().catch((error) => {
      state.lastError = String(error?.message ?? error);
    }), POLL_MS);

    app.on("activate", () => {
      if (!mainWindow) mainWindow = createMainWindow();
    });
  });

  // Tray-resident: closing the window does not quit, so the window stays warm
  // and champ select is always a navigation, never a cold boot.
  // Tray-resident: no handler at all means Electron keeps running on Windows
  // only if a window exists, so hide instead of close and never quit here.
  app.on("window-all-closed", () => {
    /* stay resident in the tray; Quit is an explicit tray action */
  });
}
