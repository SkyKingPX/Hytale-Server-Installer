const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const unzipper = require("unzipper");
const { pipeline } = require("stream");
const { promisify } = require("util");
const os = require("os");
const { exit } = require("process");

/* -------------------------------------------------
   RUNTIME PATHS
------------------------------------------------- */

const RUNTIME_DIR = process.pkg
  ? path.dirname(process.execPath)
  : process.cwd();

const LOG_FILE = path.join(RUNTIME_DIR, "installer.log");
const CONFIG_FILE = path.join(RUNTIME_DIR, "installer-config.json");

// Reset log file
try {
  fs.writeFileSync(LOG_FILE, "");
} catch (err) {
  console.error("Failed to reset log file:", err);
}

const DOWNLOAD_URL = "https://downloader.hytale.com/hytale-downloader.zip";
const DOWNLOADER_ZIP = path.join(RUNTIME_DIR, "hytale-downloader.zip");
const EXTRACT_DIR = path.join(RUNTIME_DIR, "hytale-downloader");

const platform = os.platform();
const pipelineAsync = promisify(pipeline);

let DOWNLOADER_EXE =
  platform === "win32"
    ? "hytale-downloader-windows-amd64.exe"
    : platform === "linux"
    ? "hytale-downloader-linux-amd64"
    : null;

if (!DOWNLOADER_EXE) {
  throw new Error(`Unsupported OS: ${platform}`);
}

/* -------------------------------------------------
   LOGGING SYSTEM
------------------------------------------------- */

function writeLog(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;

  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error("Failed to write log:", err);
  }

  console[level === "ERROR" ? "error" : "log"](msg);
}

const log = msg => writeLog("INFO", msg);
const warn = msg => writeLog("WARN", msg);
const error = msg => writeLog("ERROR", msg);

/* -------------------------------------------------
   CONFIG SYSTEM
------------------------------------------------- */

const DEFAULT_CONFIG = {
  startServer: true,
  cleanUp: true,
  downloaderArgs: "",
  javaArgs: "-Xms2G -Xmx4G -XX:AOTCache=HytaleServer.aot",
  hytaleArgs: "--assets Assets.zip --bind 5520"
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      log("Created default installer-config.json");
      return DEFAULT_CONFIG;
    }

    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    error("Failed to load config.json: " + err.message);
    return DEFAULT_CONFIG;
  }
}

const config = loadConfig();

/* -------------------------------------------------
   ERROR HANDLERS
------------------------------------------------- */

process.on("uncaughtException", err => {
  error("UNCAUGHT EXCEPTION: " + (err?.stack || err));
  process.exit(1);
});

process.on("unhandledRejection", err => {
  error("UNHANDLED PROMISE REJECTION: " + (err?.stack || err));
  process.exit(1);
});

/* -------------------------------------------------
   HELPERS
------------------------------------------------- */

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err && !stderr) reject(err);
      else resolve((stdout + stderr).trim());
    });
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https
      .get(url, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

async function unzipAll(zipPath, targetDir) {
  await fs.promises.mkdir(targetDir, { recursive: true });

  const directory = await unzipper.Open.file(zipPath);

  for (const file of directory.files) {
    const fullPath = path.join(targetDir, file.path);

    if (file.type === "Directory") {
      await fs.promises.mkdir(fullPath, { recursive: true });
    } else {
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await pipelineAsync(file.stream(), fs.createWriteStream(fullPath));
    }
  }
}

async function checkJava() {
  let out;

  try {
    out = await execAsync("java -version");
  } catch {
    throw new Error("Java not installed or not accessible");
  }

  const match = out.match(/version\s+"(\d+)/i);
  if (!match) throw new Error("Cannot parse Java version");

  const version = Number(match[1]);
  if (version < 25) throw new Error(`Java ${version} was detected but 25+ is required`);

  log(`Java ${version} - OK`);
}

async function runDownloader() {
  const exePath = path.resolve(EXTRACT_DIR, DOWNLOADER_EXE);

  return new Promise((resolve, reject) => {
    const args = config.downloaderArgs.split(" ");

    const downloaderArgs = [
      ...args
    ];

    const proc = spawn(exePath, downloaderArgs, { stdio: "inherit", cwd: RUNTIME_DIR });

    proc.on("error", reject);
    proc.on("exit", (code, signal) => {
      if (signal) reject(new Error(`Downloader terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`Downloader exited with code ${code}`));
      else resolve();
    });
  });
}

function findNewestZip(dir) {
  log("Searching for newest ZIP...");
  const zips = fs
    .readdirSync(dir)
    .filter(f => f.endsWith(".zip"))
    .map(f => ({
      name: f,
      time: fs.statSync(path.join(dir, f)).mtimeMs
    }))
    .sort((a, b) => b.time - a.time);

  if (!zips.length) throw new Error("No downloaded ZIP found");

  const newest = path.join(dir, zips[0].name);
  log(`Newest ZIP: ${newest}`);
  return newest;
}

async function moveAll(srcDir, destDir) {
  const items = await fs.promises.readdir(srcDir, { withFileTypes: true });

  for (const item of items) {
    const srcPath = path.join(srcDir, item.name);
    const destPath = path.join(destDir, item.name);

    if (item.isDirectory()) {
      await fs.promises.mkdir(destPath, { recursive: true });
      await moveAll(srcPath, destPath);
      await fs.promises.rmdir(srcPath).catch(() => {});
    } else {
      await fs.promises.copyFile(srcPath, destPath);
      await fs.promises.unlink(srcPath).catch(() => {});
    }
  }
}


async function deleteFiles(files) {
  for (const file of files) {
    try {
      await fs.promises.unlink(file);
    } catch {}
  }
}

async function deleteDirs(dirs) {
  for (const dir of dirs) {
    if (!dir || dir === "/" || dir === process.cwd()) continue;

    try {
      await fs.promises.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      });
    } catch (err) {
      warn(`Failed to delete ${dir}: ${err.message}`);
    }
  }
}

/* -------------------------------------------------
   FINAL SERVER START
------------------------------------------------- */

async function startServer() {
  if (!config.startServer) {
    log("Server start skipped. Exiting...");
    exit(0);
  }

  const args = config.javaArgs.split(" ");
  const hytaleArgs = config.hytaleArgs.split(" ");

  const finalArgs = [
    ...args,
    "-jar",
    "HytaleServer.jar",
    ...hytaleArgs
  ];

  log("Starting server with:");
  log("java " + finalArgs.join(" "));

  const proc = spawn("java", finalArgs, { stdio: "inherit", cwd: RUNTIME_DIR });

  proc.on("exit", code => {
    log(`Server exited with code ${code}`);
  });
  proc.on("error", err => {
    error("Failed to start server: " + err.message);
  });
}

/* -------------------------------------------------
   MAIN
------------------------------------------------- */

(async () => {
  try {
    log("=== HYTALE SERVER INSTALLER | by SkyKing_PX | Version 1.0.0 ===");

    await checkJava();

    log("Downloading Hytale downloader...");
    await downloadFile(DOWNLOAD_URL, DOWNLOADER_ZIP);

    log("Extracting Hytale downloader...");
    await unzipAll(DOWNLOADER_ZIP, EXTRACT_DIR);

    if (platform === "linux") {
      const exePath = path.join(EXTRACT_DIR, DOWNLOADER_EXE);
      await fs.promises.chmod(exePath, 0o755);
      log("Set Linux executable permissions");
    }

    log("Running Hytale downloader...");
    await runDownloader();

    log("Detecting downloaded version...");
    const downloadedZip = findNewestZip(RUNTIME_DIR);

    log("Extracting Hytale server assets...");
    await unzipAll(downloadedZip, RUNTIME_DIR);

    log("Preparing assets...")
    await moveAll(path.join(RUNTIME_DIR, "Server"), RUNTIME_DIR);

    if (config.cleanUp) {
      log("Cleaning up...");
      await deleteFiles([DOWNLOADER_ZIP, downloadedZip, "QUICKSTART.md"]);
      await deleteDirs([EXTRACT_DIR, path.join(RUNTIME_DIR, "Server")]);
    } else {
      log("Cleanup skipped");
    }
    log("Done.");

    await startServer();
    process.on("exit", () => log("Exiting Installer..."));
  } catch (err) {
    error("FATAL ERROR: " + err.stack);
    exit(1);
  }
})();
