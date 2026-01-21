import { exec, spawn } from "child_process";
import fs from "fs";
import path from "path";
import https from "https";
import unzipper from "unzipper";
import { pipeline } from "stream";
import { promisify } from "util";
import os from "os";
import { exit } from "process";

const RUNTIME_DIR = process.cwd();

const DOWNLOAD_URL = "https://downloader.hytale.com/hytale-downloader.zip";
const DOWNLOADER_ZIP = path.join(RUNTIME_DIR, "hytale-downloader.zip");
const EXTRACT_DIR = path.join(RUNTIME_DIR, "hytale-downloader");
const platform = os.platform();
const pipelineAsync = promisify(pipeline);
let DOWNLOADER_EXE;

if (platform === "win32") {
  DOWNLOADER_EXE = "hytale-downloader-windows-amd64.exe";
} else if (platform === "linux") {
  DOWNLOADER_EXE = "hytale-downloader-linux-amd64";
} else {
  throw new Error(`Unsupported OS: ${platform}`);
}

/* ---------- helpers ---------- */

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
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
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

      await pipelineAsync(
        file.stream(),
        fs.createWriteStream(fullPath)
      );
    }
  }
}

/* ---------- steps ---------- */

async function checkJava() {
  let out;

  try {
    out = await execAsync("java -version");
  } catch {
    throw new Error("Java not installed or not accessible");
  }

  const match = out.match(/version\s+"(\d+)/i);
  if (!match) {
    throw new Error("Cannot parse Java version");
  }

  const version = Number(match[1]);
  if (version < 25) {
    throw new Error(`Java ${version} detected, 25+ required`);
  }

  console.log(`Java ${version} OK`);
}

async function runDownloader() {
  const exePath = path.join(EXTRACT_DIR, DOWNLOADER_EXE);

  return new Promise((resolve, reject) => {
    const proc = spawn(exePath, [], {
      stdio: "inherit"
    });

    proc.on("exit", code =>
      code === 0 ? resolve() : reject(new Error("Downloader failed"))
    );
  });
}

function findNewestZip(dir) {
  const zips = fs.readdirSync(dir)
    .filter(f => f.endsWith(".zip"))
    .map(f => ({
      name: f,
      time: fs.statSync(path.join(dir, f)).mtimeMs
    }))
    .sort((a, b) => b.time - a.time);

  if (!zips.length) throw new Error("No downloaded ZIP found");
  return path.join(dir, zips[0].name);
}

async function deleteFiles(files) {
  for (const file of files) {
    await fs.promises.unlink(file).catch(() => {});
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
      console.warn("Failed to delete:", dir, err.message);
    }
  }
}


/* ---------- main ---------- */

(async () => {
  await checkJava();

  console.log("Downloading Hytale downloader...");
  await downloadFile(DOWNLOAD_URL, DOWNLOADER_ZIP);

  console.log("Extracting Hytale downloader...");
  await unzipAll(DOWNLOADER_ZIP, EXTRACT_DIR);

  if (platform === "linux") {
    const exePath = path.join(EXTRACT_DIR, DOWNLOADER_EXE);
    await fs.promises.chmod(exePath, 0o755);
  }

  console.log("Running Hytale downloader...");
  await runDownloader();

  console.log("Detecting downloaded Version...");
  const downloadedZip = findNewestZip(RUNTIME_DIR);

  console.log("Extracting Hytale server assets...");
  await unzipAll(downloadedZip, RUNTIME_DIR);

  console.log("Cleaning up...");
  await deleteFiles([DOWNLOADER_ZIP, downloadedZip, "QUICKSTART.md"]);
  await deleteDirs([EXTRACT_DIR]);

  console.log("Done.");
  exit(0);
})();
