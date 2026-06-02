const { app, BrowserWindow, Menu } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

const PORT = 3003;
let mainWindow = null;
let serverProcess = null;

// Resolve paths: in dev mode, files are at ../; in packaged mode, in resources/
function getResource(relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(__dirname, "..", relativePath);
}

function getNodeExe() {
  // Bundled Node or system Node
  const bundled = path.join(process.resourcesPath, "node", "node.exe");
  if (fs.existsSync(bundled)) return bundled;
  return "node";
}

function startServer() {
  const serverJs = getResource("server.js");
  // In packaged mode, server.js lives in resources/, but pi.exe and .sessions
  // are expected at dirname(dirname(server.js)). Set cwd accordingly.
  const isPkg = app.isPackaged;
  const cwd = isPkg ? process.resourcesPath : getResource(".");

  console.log("Starting server:", serverJs);
  console.log("Working dir:", cwd);
  console.log("Packaged:", isPkg);

  serverProcess = spawn(getNodeExe(), [serverJs], {
    cwd,
    env: { ...process.env, PORT: String(PORT), PI_PACKAGED: isPkg ? "1" : "0", PI_RESOURCES: isPkg ? process.resourcesPath : "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (d) => console.log("[server]", d.toString().trim()));
  serverProcess.stderr.on("data", (d) => console.error("[server:err]", d.toString().trim()));
  serverProcess.on("close", (code) => {
    console.log("Server exited with code", code);
    serverProcess = null;
    if (code !== 0 && mainWindow) {
      // Server crashed; show error in window
      mainWindow.loadURL(`data:text/html,<h2>Server stopped unexpectedly (code ${code}). Please restart the app.</h2>`);
    }
  });
}

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    function check(n) {
      if (n <= 0) return reject(new Error("Server did not start in time"));
      http.get(`http://127.0.0.1:${PORT}/`, (res) => {
        resolve();
      }).on("error", () => {
        setTimeout(() => check(n - 1), 500);
      });
    }
    check(retries);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: "PI Agent",
    icon: (() => {
    const rp = path.join(process.resourcesPath, "icon.ico");
    if (fs.existsSync(rp)) return rp;
    const local = path.join(__dirname, "icon.ico");
    if (fs.existsSync(local)) return local;
    return rp; // fallback
  })(),
    backgroundColor: "#0d1117",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Remove menu bar
  Menu.setApplicationMenu(null);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
}

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer();
  } catch (e) {
    console.error("Failed to start server:", e.message);
    app.quit();
    return;
  }
  await createWindow();
});

app.on("window-all-closed", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
