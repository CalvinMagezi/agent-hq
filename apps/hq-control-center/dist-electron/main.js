var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { app, ipcMain, BrowserWindow, session, nativeImage } from "electron";
import { fileURLToPath } from "node:url";
import * as sp from "node:path";
import sp__default, { resolve, join, relative, sep } from "node:path";
import os, { type } from "node:os";
import { execSync, spawn } from "node:child_process";
import fs, { lstat, stat, readdir, realpath, open } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { unwatchFile, watchFile, watch as watch$1, stat as stat$1 } from "node:fs";
import { Readable } from "node:stream";
const IPC = {
  // Renderer → Main (invoke)
  START_DAEMON: "daemon:start",
  STOP_DAEMON: "daemon:stop",
  SAVE_ENV_CONFIG: "config:save-env",
  TRIGGER_WORKFLOW: "workflow:trigger",
  GET_ENV_CONFIG: "config:get-env",
  GET_VAULT_PATH: "vault:get-path",
  CHECK_DEPENDENCIES: "system:check-deps",
  GET_VAULT_GRAPH: "vault:get-graph",
  LOAD_LAYOUT: "layout:load",
  SAVE_LAYOUT: "layout:save",
  // Main → Renderer (send)
  DAEMON_LOG: "daemon:log",
  DAEMON_STATUS: "daemon:status",
  VAULT_UPDATE: "vault:update",
  SYSTEM_STATS: "system:stats",
  VAULT_GRAPH_UPDATE: "vault:graph-updated"
};
const __dirname$4 = sp__default.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT$1 = sp__default.resolve(__dirname$4, "../../..");
const ENV_PATH = sp__default.join(MONOREPO_ROOT$1, ".env.local");
class EnvManager {
  async getVaultPath() {
    const config = await this.readEnv();
    if (config.VAULT_PATH) return config.VAULT_PATH;
    return sp__default.join(MONOREPO_ROOT$1, ".vault");
  }
  async readEnv() {
    try {
      const content = await fs.readFile(ENV_PATH, "utf-8");
      const lines = content.split("\n");
      const config = {};
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let value = trimmed.slice(eqIdx + 1).trim();
          if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1);
          }
          config[key] = value;
        }
      }
      return config;
    } catch (e) {
      if (e.code === "ENOENT") {
        return {};
      }
      throw e;
    }
  }
  async writeEnv(config) {
    try {
      let existingContent = "";
      try {
        existingContent = await fs.readFile(ENV_PATH, "utf-8");
      } catch (e) {
      }
      const lines = existingContent ? existingContent.split("\n") : [];
      const updatedKeys = /* @__PURE__ */ new Set();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            if (config[key] !== void 0) {
              lines[i] = `${key}="${config[key]}"`;
              updatedKeys.add(key);
            }
          }
        }
      }
      let addedAny = false;
      for (const [key, value] of Object.entries(config)) {
        if (!updatedKeys.has(key) && value !== void 0) {
          if (!addedAny && lines.length > 0 && lines[lines.length - 1] !== "") {
            lines.push("");
          }
          lines.push(`${key}="${value}"`);
          addedAny = true;
        }
      }
      await fs.writeFile(ENV_PATH, lines.join("\n"), "utf-8");
      return true;
    } catch (e) {
      console.error("[EnvManager] Error writing env:", e);
      return false;
    }
  }
}
const envManager = new EnvManager();
const __dirname$3 = sp__default.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = sp__default.resolve(__dirname$3, "../../..");
class DaemonManager {
  constructor() {
    __publicField(this, "daemonProcess", null);
    __publicField(this, "relayProcess", null);
    __publicField(this, "startTime", null);
    __publicField(this, "mainWindow", null);
    __publicField(this, "statusTimer", null);
  }
  async checkDependencies() {
    let bunInstalled = false;
    let bunVersion = null;
    let nodeVersion = process.version;
    try {
      bunVersion = execSync("bun --version", { encoding: "utf-8" }).trim();
      bunInstalled = true;
    } catch (e) {
    }
    const config = await envManager.readEnv();
    const envFileExists = Object.keys(config).length > 0;
    const vaultPathExists = true;
    return {
      bunInstalled,
      bunVersion,
      nodeVersion,
      envFileExists,
      vaultPathExists
    };
  }
  /**
   * Check if the relay server is already running externally (port 18900).
   */
  isRelayRunning() {
    try {
      const result = execSync("lsof -i :18900 -P -n 2>/dev/null | grep LISTEN", { encoding: "utf-8" });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }
  /**
   * Check if the daemon is already running externally via process check.
   */
  isDaemonRunning() {
    try {
      const result = execSync('ps aux 2>/dev/null | grep "agent-hq-daemon" | grep -v grep', { encoding: "utf-8" });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }
  start(window) {
    var _a, _b, _c, _d;
    this.mainWindow = window;
    try {
      if (!this.relayProcess && !this.isRelayRunning()) {
        this.sendLog("stdout", "[DaemonManager] Starting relay server...\n");
        this.relayProcess = spawn("bun", ["run", "relay-server"], {
          cwd: MONOREPO_ROOT,
          env: { ...process.env, FORCE_COLOR: "1" }
        });
        (_a = this.relayProcess.stdout) == null ? void 0 : _a.on("data", (data) => {
          this.sendLog("stdout", `[relay] ${data.toString()}`);
        });
        (_b = this.relayProcess.stderr) == null ? void 0 : _b.on("data", (data) => {
          this.sendLog("stderr", `[relay] ${data.toString()}`);
        });
        this.relayProcess.on("exit", (code) => {
          this.sendLog("stderr", `[relay] Relay server exited with code ${code}
`);
          this.relayProcess = null;
        });
      } else {
        this.sendLog("stdout", "[DaemonManager] Relay server already running.\n");
      }
      if (!this.daemonProcess && !this.isDaemonRunning()) {
        this.sendLog("stdout", "[DaemonManager] Starting daemon...\n");
        this.daemonProcess = spawn("bun", ["run", "daemon"], {
          cwd: MONOREPO_ROOT,
          env: { ...process.env, FORCE_COLOR: "1" }
          // Preserve ANSI colors
        });
        this.startTime = Date.now();
        (_c = this.daemonProcess.stdout) == null ? void 0 : _c.on("data", (data) => {
          this.sendLog("stdout", data.toString());
        });
        (_d = this.daemonProcess.stderr) == null ? void 0 : _d.on("data", (data) => {
          this.sendLog("stderr", data.toString());
        });
        this.daemonProcess.on("exit", (code) => {
          this.sendLog("stderr", `Daemon exited with code ${code}`);
          this.daemonProcess = null;
          this.startTime = null;
          this.broadcastStatus();
        });
      } else {
        this.sendLog("stdout", "[DaemonManager] Daemon already running.\n");
        if (!this.startTime) this.startTime = Date.now();
      }
      if (!this.statusTimer) {
        this.statusTimer = setInterval(() => this.broadcastStatus(), 2e3);
      }
      this.broadcastStatus();
      return true;
    } catch (e) {
      this.sendLog("stderr", `Failed to start daemon: ${e.message}`);
      return false;
    }
  }
  stop() {
    try {
      if (this.relayProcess) {
        this.relayProcess.kill("SIGTERM");
        this.relayProcess = null;
      }
      if (this.daemonProcess) {
        this.daemonProcess.kill("SIGTERM");
        const pid = this.daemonProcess.pid;
        setTimeout(() => {
          if (this.daemonProcess && this.daemonProcess.pid === pid) {
            try {
              this.daemonProcess.kill("SIGKILL");
            } catch (e) {
            }
          }
        }, 5e3);
      }
      this.daemonProcess = null;
      this.startTime = null;
      if (this.statusTimer) {
        clearInterval(this.statusTimer);
        this.statusTimer = null;
      }
      this.broadcastStatus();
      return true;
    } catch (e) {
      return false;
    }
  }
  async triggerWorkflow(name) {
    return new Promise((resolve2) => {
      var _a, _b;
      try {
        const wfProcess = spawn("bun", ["run", `scripts/workflows/${name}.ts`], {
          cwd: MONOREPO_ROOT,
          env: { ...process.env, FORCE_COLOR: "1" }
        });
        let output = "";
        (_a = wfProcess.stdout) == null ? void 0 : _a.on("data", (data) => {
          const chunk = data.toString();
          output += chunk;
          this.sendLog("stdout", `[Workflow ${name}] ${chunk}`);
        });
        (_b = wfProcess.stderr) == null ? void 0 : _b.on("data", (data) => {
          const chunk = data.toString();
          output += chunk;
          this.sendLog("stderr", `[Workflow ${name}] ${chunk}`);
        });
        wfProcess.on("close", (code) => {
          resolve2(`Workflow ${name} exited with code ${code}
${output}`);
        });
      } catch (e) {
        resolve2(`Failed to trigger workflow: ${e.message}`);
      }
    });
  }
  sendLog(stream, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC.DAEMON_LOG, {
        stream,
        data,
        timestamp: Date.now()
      });
    }
  }
  broadcastStatus() {
    var _a;
    const running = !!this.daemonProcess || this.isDaemonRunning();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC.DAEMON_STATUS, {
        running,
        pid: ((_a = this.daemonProcess) == null ? void 0 : _a.pid) || null,
        uptime: this.startTime ? Date.now() - this.startTime : null
      });
    }
  }
}
const daemonManager = new DaemonManager();
const EntryTypes = {
  FILE_TYPE: "files",
  DIR_TYPE: "directories",
  FILE_DIR_TYPE: "files_directories",
  EVERYTHING_TYPE: "all"
};
const defaultOptions = {
  root: ".",
  fileFilter: (_entryInfo) => true,
  directoryFilter: (_entryInfo) => true,
  type: EntryTypes.FILE_TYPE,
  lstat: false,
  depth: 2147483648,
  alwaysStat: false,
  highWaterMark: 4096
};
Object.freeze(defaultOptions);
const RECURSIVE_ERROR_CODE = "READDIRP_RECURSIVE_ERROR";
const NORMAL_FLOW_ERRORS = /* @__PURE__ */ new Set(["ENOENT", "EPERM", "EACCES", "ELOOP", RECURSIVE_ERROR_CODE]);
const ALL_TYPES = [
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
];
const DIR_TYPES = /* @__PURE__ */ new Set([
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE
]);
const FILE_TYPES = /* @__PURE__ */ new Set([
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
]);
const isNormalFlowError = (error) => NORMAL_FLOW_ERRORS.has(error.code);
const wantBigintFsStats = process.platform === "win32";
const emptyFn = (_entryInfo) => true;
const normalizeFilter = (filter) => {
  if (filter === void 0)
    return emptyFn;
  if (typeof filter === "function")
    return filter;
  if (typeof filter === "string") {
    const fl = filter.trim();
    return (entry) => entry.basename === fl;
  }
  if (Array.isArray(filter)) {
    const trItems = filter.map((item) => item.trim());
    return (entry) => trItems.some((f) => entry.basename === f);
  }
  return emptyFn;
};
class ReaddirpStream extends Readable {
  constructor(options = {}) {
    super({
      objectMode: true,
      autoDestroy: true,
      highWaterMark: options.highWaterMark
    });
    __publicField(this, "parents");
    __publicField(this, "reading");
    __publicField(this, "parent");
    __publicField(this, "_stat");
    __publicField(this, "_maxDepth");
    __publicField(this, "_wantsDir");
    __publicField(this, "_wantsFile");
    __publicField(this, "_wantsEverything");
    __publicField(this, "_root");
    __publicField(this, "_isDirent");
    __publicField(this, "_statsProp");
    __publicField(this, "_rdOptions");
    __publicField(this, "_fileFilter");
    __publicField(this, "_directoryFilter");
    const opts = { ...defaultOptions, ...options };
    const { root, type: type2 } = opts;
    this._fileFilter = normalizeFilter(opts.fileFilter);
    this._directoryFilter = normalizeFilter(opts.directoryFilter);
    const statMethod = opts.lstat ? lstat : stat;
    if (wantBigintFsStats) {
      this._stat = (path) => statMethod(path, { bigint: true });
    } else {
      this._stat = statMethod;
    }
    this._maxDepth = opts.depth != null && Number.isSafeInteger(opts.depth) ? opts.depth : defaultOptions.depth;
    this._wantsDir = type2 ? DIR_TYPES.has(type2) : false;
    this._wantsFile = type2 ? FILE_TYPES.has(type2) : false;
    this._wantsEverything = type2 === EntryTypes.EVERYTHING_TYPE;
    this._root = resolve(root);
    this._isDirent = !opts.alwaysStat;
    this._statsProp = this._isDirent ? "dirent" : "stats";
    this._rdOptions = { encoding: "utf8", withFileTypes: this._isDirent };
    this.parents = [this._exploreDir(root, 1)];
    this.reading = false;
    this.parent = void 0;
  }
  async _read(batch) {
    if (this.reading)
      return;
    this.reading = true;
    try {
      while (!this.destroyed && batch > 0) {
        const par = this.parent;
        const fil = par && par.files;
        if (fil && fil.length > 0) {
          const { path, depth } = par;
          const slice = fil.splice(0, batch).map((dirent) => this._formatEntry(dirent, path));
          const awaited = await Promise.all(slice);
          for (const entry of awaited) {
            if (!entry)
              continue;
            if (this.destroyed)
              return;
            const entryType = await this._getEntryType(entry);
            if (entryType === "directory" && this._directoryFilter(entry)) {
              if (depth <= this._maxDepth) {
                this.parents.push(this._exploreDir(entry.fullPath, depth + 1));
              }
              if (this._wantsDir) {
                this.push(entry);
                batch--;
              }
            } else if ((entryType === "file" || this._includeAsFile(entry)) && this._fileFilter(entry)) {
              if (this._wantsFile) {
                this.push(entry);
                batch--;
              }
            }
          }
        } else {
          const parent = this.parents.pop();
          if (!parent) {
            this.push(null);
            break;
          }
          this.parent = await parent;
          if (this.destroyed)
            return;
        }
      }
    } catch (error) {
      this.destroy(error);
    } finally {
      this.reading = false;
    }
  }
  async _exploreDir(path, depth) {
    let files;
    try {
      files = await readdir(path, this._rdOptions);
    } catch (error) {
      this._onError(error);
    }
    return { files, depth, path };
  }
  async _formatEntry(dirent, path) {
    let entry;
    const basename = this._isDirent ? dirent.name : dirent;
    try {
      const fullPath = resolve(join(path, basename));
      entry = { path: relative(this._root, fullPath), fullPath, basename };
      entry[this._statsProp] = this._isDirent ? dirent : await this._stat(fullPath);
    } catch (err) {
      this._onError(err);
      return;
    }
    return entry;
  }
  _onError(err) {
    if (isNormalFlowError(err) && !this.destroyed) {
      this.emit("warn", err);
    } else {
      this.destroy(err);
    }
  }
  async _getEntryType(entry) {
    if (!entry && this._statsProp in entry) {
      return "";
    }
    const stats = entry[this._statsProp];
    if (stats.isFile())
      return "file";
    if (stats.isDirectory())
      return "directory";
    if (stats && stats.isSymbolicLink()) {
      const full = entry.fullPath;
      try {
        const entryRealPath = await realpath(full);
        const entryRealPathStats = await lstat(entryRealPath);
        if (entryRealPathStats.isFile()) {
          return "file";
        }
        if (entryRealPathStats.isDirectory()) {
          const len = entryRealPath.length;
          if (full.startsWith(entryRealPath) && full.substr(len, 1) === sep) {
            const recursiveError = new Error(`Circular symlink detected: "${full}" points to "${entryRealPath}"`);
            recursiveError.code = RECURSIVE_ERROR_CODE;
            return this._onError(recursiveError);
          }
          return "directory";
        }
      } catch (error) {
        this._onError(error);
        return "";
      }
    }
  }
  _includeAsFile(entry) {
    const stats = entry && entry[this._statsProp];
    return stats && this._wantsEverything && !stats.isDirectory();
  }
}
function readdirp(root, options = {}) {
  let type2 = options.entryType || options.type;
  if (type2 === "both")
    type2 = EntryTypes.FILE_DIR_TYPE;
  if (type2)
    options.type = type2;
  if (!root) {
    throw new Error("readdirp: root argument is required. Usage: readdirp(root, options)");
  } else if (typeof root !== "string") {
    throw new TypeError("readdirp: root argument must be a string. Usage: readdirp(root, options)");
  } else if (type2 && !ALL_TYPES.includes(type2)) {
    throw new Error(`readdirp: Invalid type passed. Use one of ${ALL_TYPES.join(", ")}`);
  }
  options.root = root;
  return new ReaddirpStream(options);
}
const STR_DATA = "data";
const STR_END = "end";
const STR_CLOSE = "close";
const EMPTY_FN = () => {
};
const pl = process.platform;
const isWindows = pl === "win32";
const isMacos = pl === "darwin";
const isLinux = pl === "linux";
const isFreeBSD = pl === "freebsd";
const isIBMi = type() === "OS400";
const EVENTS = {
  ALL: "all",
  READY: "ready",
  ADD: "add",
  CHANGE: "change",
  ADD_DIR: "addDir",
  UNLINK: "unlink",
  UNLINK_DIR: "unlinkDir",
  RAW: "raw",
  ERROR: "error"
};
const EV = EVENTS;
const THROTTLE_MODE_WATCH = "watch";
const statMethods = { lstat, stat };
const KEY_LISTENERS = "listeners";
const KEY_ERR = "errHandlers";
const KEY_RAW = "rawEmitters";
const HANDLER_KEYS = [KEY_LISTENERS, KEY_ERR, KEY_RAW];
const binaryExtensions = /* @__PURE__ */ new Set([
  "3dm",
  "3ds",
  "3g2",
  "3gp",
  "7z",
  "a",
  "aac",
  "adp",
  "afdesign",
  "afphoto",
  "afpub",
  "ai",
  "aif",
  "aiff",
  "alz",
  "ape",
  "apk",
  "appimage",
  "ar",
  "arj",
  "asf",
  "au",
  "avi",
  "bak",
  "baml",
  "bh",
  "bin",
  "bk",
  "bmp",
  "btif",
  "bz2",
  "bzip2",
  "cab",
  "caf",
  "cgm",
  "class",
  "cmx",
  "cpio",
  "cr2",
  "cur",
  "dat",
  "dcm",
  "deb",
  "dex",
  "djvu",
  "dll",
  "dmg",
  "dng",
  "doc",
  "docm",
  "docx",
  "dot",
  "dotm",
  "dra",
  "DS_Store",
  "dsk",
  "dts",
  "dtshd",
  "dvb",
  "dwg",
  "dxf",
  "ecelp4800",
  "ecelp7470",
  "ecelp9600",
  "egg",
  "eol",
  "eot",
  "epub",
  "exe",
  "f4v",
  "fbs",
  "fh",
  "fla",
  "flac",
  "flatpak",
  "fli",
  "flv",
  "fpx",
  "fst",
  "fvt",
  "g3",
  "gh",
  "gif",
  "graffle",
  "gz",
  "gzip",
  "h261",
  "h263",
  "h264",
  "icns",
  "ico",
  "ief",
  "img",
  "ipa",
  "iso",
  "jar",
  "jpeg",
  "jpg",
  "jpgv",
  "jpm",
  "jxr",
  "key",
  "ktx",
  "lha",
  "lib",
  "lvp",
  "lz",
  "lzh",
  "lzma",
  "lzo",
  "m3u",
  "m4a",
  "m4v",
  "mar",
  "mdi",
  "mht",
  "mid",
  "midi",
  "mj2",
  "mka",
  "mkv",
  "mmr",
  "mng",
  "mobi",
  "mov",
  "movie",
  "mp3",
  "mp4",
  "mp4a",
  "mpeg",
  "mpg",
  "mpga",
  "mxu",
  "nef",
  "npx",
  "numbers",
  "nupkg",
  "o",
  "odp",
  "ods",
  "odt",
  "oga",
  "ogg",
  "ogv",
  "otf",
  "ott",
  "pages",
  "pbm",
  "pcx",
  "pdb",
  "pdf",
  "pea",
  "pgm",
  "pic",
  "png",
  "pnm",
  "pot",
  "potm",
  "potx",
  "ppa",
  "ppam",
  "ppm",
  "pps",
  "ppsm",
  "ppsx",
  "ppt",
  "pptm",
  "pptx",
  "psd",
  "pya",
  "pyc",
  "pyo",
  "pyv",
  "qt",
  "rar",
  "ras",
  "raw",
  "resources",
  "rgb",
  "rip",
  "rlc",
  "rmf",
  "rmvb",
  "rpm",
  "rtf",
  "rz",
  "s3m",
  "s7z",
  "scpt",
  "sgi",
  "shar",
  "snap",
  "sil",
  "sketch",
  "slk",
  "smv",
  "snk",
  "so",
  "stl",
  "suo",
  "sub",
  "swf",
  "tar",
  "tbz",
  "tbz2",
  "tga",
  "tgz",
  "thmx",
  "tif",
  "tiff",
  "tlz",
  "ttc",
  "ttf",
  "txz",
  "udf",
  "uvh",
  "uvi",
  "uvm",
  "uvp",
  "uvs",
  "uvu",
  "viv",
  "vob",
  "war",
  "wav",
  "wax",
  "wbmp",
  "wdp",
  "weba",
  "webm",
  "webp",
  "whl",
  "wim",
  "wm",
  "wma",
  "wmv",
  "wmx",
  "woff",
  "woff2",
  "wrm",
  "wvx",
  "xbm",
  "xif",
  "xla",
  "xlam",
  "xls",
  "xlsb",
  "xlsm",
  "xlsx",
  "xlt",
  "xltm",
  "xltx",
  "xm",
  "xmind",
  "xpi",
  "xpm",
  "xwd",
  "xz",
  "z",
  "zip",
  "zipx"
]);
const isBinaryPath = (filePath) => binaryExtensions.has(sp.extname(filePath).slice(1).toLowerCase());
const foreach = (val, fn) => {
  if (val instanceof Set) {
    val.forEach(fn);
  } else {
    fn(val);
  }
};
const addAndConvert = (main, prop, item) => {
  let container = main[prop];
  if (!(container instanceof Set)) {
    main[prop] = container = /* @__PURE__ */ new Set([container]);
  }
  container.add(item);
};
const clearItem = (cont) => (key) => {
  const set = cont[key];
  if (set instanceof Set) {
    set.clear();
  } else {
    delete cont[key];
  }
};
const delFromSet = (main, prop, item) => {
  const container = main[prop];
  if (container instanceof Set) {
    container.delete(item);
  } else if (container === item) {
    delete main[prop];
  }
};
const isEmptySet = (val) => val instanceof Set ? val.size === 0 : !val;
const FsWatchInstances = /* @__PURE__ */ new Map();
function createFsWatchInstance(path, options, listener, errHandler, emitRaw) {
  const handleEvent = (rawEvent, evPath) => {
    listener(path);
    emitRaw(rawEvent, evPath, { watchedPath: path });
    if (evPath && path !== evPath) {
      fsWatchBroadcast(sp.resolve(path, evPath), KEY_LISTENERS, sp.join(path, evPath));
    }
  };
  try {
    return watch$1(path, {
      persistent: options.persistent
    }, handleEvent);
  } catch (error) {
    errHandler(error);
    return void 0;
  }
}
const fsWatchBroadcast = (fullPath, listenerType, val1, val2, val3) => {
  const cont = FsWatchInstances.get(fullPath);
  if (!cont)
    return;
  foreach(cont[listenerType], (listener) => {
    listener(val1, val2, val3);
  });
};
const setFsWatchListener = (path, fullPath, options, handlers) => {
  const { listener, errHandler, rawEmitter } = handlers;
  let cont = FsWatchInstances.get(fullPath);
  let watcher;
  if (!options.persistent) {
    watcher = createFsWatchInstance(path, options, listener, errHandler, rawEmitter);
    if (!watcher)
      return;
    return watcher.close.bind(watcher);
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_ERR, errHandler);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    watcher = createFsWatchInstance(
      path,
      options,
      fsWatchBroadcast.bind(null, fullPath, KEY_LISTENERS),
      errHandler,
      // no need to use broadcast here
      fsWatchBroadcast.bind(null, fullPath, KEY_RAW)
    );
    if (!watcher)
      return;
    watcher.on(EV.ERROR, async (error) => {
      const broadcastErr = fsWatchBroadcast.bind(null, fullPath, KEY_ERR);
      if (cont)
        cont.watcherUnusable = true;
      if (isWindows && error.code === "EPERM") {
        try {
          const fd = await open(path, "r");
          await fd.close();
          broadcastErr(error);
        } catch (err) {
        }
      } else {
        broadcastErr(error);
      }
    });
    cont = {
      listeners: listener,
      errHandlers: errHandler,
      rawEmitters: rawEmitter,
      watcher
    };
    FsWatchInstances.set(fullPath, cont);
  }
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_ERR, errHandler);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      cont.watcher.close();
      FsWatchInstances.delete(fullPath);
      HANDLER_KEYS.forEach(clearItem(cont));
      cont.watcher = void 0;
      Object.freeze(cont);
    }
  };
};
const FsWatchFileInstances = /* @__PURE__ */ new Map();
const setFsWatchFileListener = (path, fullPath, options, handlers) => {
  const { listener, rawEmitter } = handlers;
  let cont = FsWatchFileInstances.get(fullPath);
  const copts = cont && cont.options;
  if (copts && (copts.persistent < options.persistent || copts.interval > options.interval)) {
    unwatchFile(fullPath);
    cont = void 0;
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    cont = {
      listeners: listener,
      rawEmitters: rawEmitter,
      options,
      watcher: watchFile(fullPath, options, (curr, prev) => {
        foreach(cont.rawEmitters, (rawEmitter2) => {
          rawEmitter2(EV.CHANGE, fullPath, { curr, prev });
        });
        const currmtime = curr.mtimeMs;
        if (curr.size !== prev.size || currmtime > prev.mtimeMs || currmtime === 0) {
          foreach(cont.listeners, (listener2) => listener2(path, curr));
        }
      })
    };
    FsWatchFileInstances.set(fullPath, cont);
  }
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      FsWatchFileInstances.delete(fullPath);
      unwatchFile(fullPath);
      cont.options = cont.watcher = void 0;
      Object.freeze(cont);
    }
  };
};
class NodeFsHandler {
  constructor(fsW) {
    __publicField(this, "fsw");
    __publicField(this, "_boundHandleError");
    this.fsw = fsW;
    this._boundHandleError = (error) => fsW._handleError(error);
  }
  /**
   * Watch file for changes with fs_watchFile or fs_watch.
   * @param path to file or dir
   * @param listener on fs change
   * @returns closer for the watcher instance
   */
  _watchWithNodeFs(path, listener) {
    const opts = this.fsw.options;
    const directory = sp.dirname(path);
    const basename = sp.basename(path);
    const parent = this.fsw._getWatchedDir(directory);
    parent.add(basename);
    const absolutePath = sp.resolve(path);
    const options = {
      persistent: opts.persistent
    };
    if (!listener)
      listener = EMPTY_FN;
    let closer;
    if (opts.usePolling) {
      const enableBin = opts.interval !== opts.binaryInterval;
      options.interval = enableBin && isBinaryPath(basename) ? opts.binaryInterval : opts.interval;
      closer = setFsWatchFileListener(path, absolutePath, options, {
        listener,
        rawEmitter: this.fsw._emitRaw
      });
    } else {
      closer = setFsWatchListener(path, absolutePath, options, {
        listener,
        errHandler: this._boundHandleError,
        rawEmitter: this.fsw._emitRaw
      });
    }
    return closer;
  }
  /**
   * Watch a file and emit add event if warranted.
   * @returns closer for the watcher instance
   */
  _handleFile(file, stats, initialAdd) {
    if (this.fsw.closed) {
      return;
    }
    const dirname = sp.dirname(file);
    const basename = sp.basename(file);
    const parent = this.fsw._getWatchedDir(dirname);
    let prevStats = stats;
    if (parent.has(basename))
      return;
    const listener = async (path, newStats) => {
      if (!this.fsw._throttle(THROTTLE_MODE_WATCH, file, 5))
        return;
      if (!newStats || newStats.mtimeMs === 0) {
        try {
          const newStats2 = await stat(file);
          if (this.fsw.closed)
            return;
          const at = newStats2.atimeMs;
          const mt = newStats2.mtimeMs;
          if (!at || at <= mt || mt !== prevStats.mtimeMs) {
            this.fsw._emit(EV.CHANGE, file, newStats2);
          }
          if ((isMacos || isLinux || isFreeBSD) && prevStats.ino !== newStats2.ino) {
            this.fsw._closeFile(path);
            prevStats = newStats2;
            const closer2 = this._watchWithNodeFs(file, listener);
            if (closer2)
              this.fsw._addPathCloser(path, closer2);
          } else {
            prevStats = newStats2;
          }
        } catch (error) {
          this.fsw._remove(dirname, basename);
        }
      } else if (parent.has(basename)) {
        const at = newStats.atimeMs;
        const mt = newStats.mtimeMs;
        if (!at || at <= mt || mt !== prevStats.mtimeMs) {
          this.fsw._emit(EV.CHANGE, file, newStats);
        }
        prevStats = newStats;
      }
    };
    const closer = this._watchWithNodeFs(file, listener);
    if (!(initialAdd && this.fsw.options.ignoreInitial) && this.fsw._isntIgnored(file)) {
      if (!this.fsw._throttle(EV.ADD, file, 0))
        return;
      this.fsw._emit(EV.ADD, file, stats);
    }
    return closer;
  }
  /**
   * Handle symlinks encountered while reading a dir.
   * @param entry returned by readdirp
   * @param directory path of dir being read
   * @param path of this item
   * @param item basename of this item
   * @returns true if no more processing is needed for this entry.
   */
  async _handleSymlink(entry, directory, path, item) {
    if (this.fsw.closed) {
      return;
    }
    const full = entry.fullPath;
    const dir = this.fsw._getWatchedDir(directory);
    if (!this.fsw.options.followSymlinks) {
      this.fsw._incrReadyCount();
      let linkPath;
      try {
        linkPath = await realpath(path);
      } catch (e) {
        this.fsw._emitReady();
        return true;
      }
      if (this.fsw.closed)
        return;
      if (dir.has(item)) {
        if (this.fsw._symlinkPaths.get(full) !== linkPath) {
          this.fsw._symlinkPaths.set(full, linkPath);
          this.fsw._emit(EV.CHANGE, path, entry.stats);
        }
      } else {
        dir.add(item);
        this.fsw._symlinkPaths.set(full, linkPath);
        this.fsw._emit(EV.ADD, path, entry.stats);
      }
      this.fsw._emitReady();
      return true;
    }
    if (this.fsw._symlinkPaths.has(full)) {
      return true;
    }
    this.fsw._symlinkPaths.set(full, true);
  }
  _handleRead(directory, initialAdd, wh, target, dir, depth, throttler) {
    directory = sp.join(directory, "");
    const throttleKey = target ? `${directory}:${target}` : directory;
    throttler = this.fsw._throttle("readdir", throttleKey, 1e3);
    if (!throttler)
      return;
    const previous = this.fsw._getWatchedDir(wh.path);
    const current = /* @__PURE__ */ new Set();
    let stream = this.fsw._readdirp(directory, {
      fileFilter: (entry) => wh.filterPath(entry),
      directoryFilter: (entry) => wh.filterDir(entry)
    });
    if (!stream)
      return;
    stream.on(STR_DATA, async (entry) => {
      if (this.fsw.closed) {
        stream = void 0;
        return;
      }
      const item = entry.path;
      let path = sp.join(directory, item);
      current.add(item);
      if (entry.stats.isSymbolicLink() && await this._handleSymlink(entry, directory, path, item)) {
        return;
      }
      if (this.fsw.closed) {
        stream = void 0;
        return;
      }
      if (item === target || !target && !previous.has(item)) {
        this.fsw._incrReadyCount();
        path = sp.join(dir, sp.relative(dir, path));
        this._addToNodeFs(path, initialAdd, wh, depth + 1);
      }
    }).on(EV.ERROR, this._boundHandleError);
    return new Promise((resolve2, reject) => {
      if (!stream)
        return reject();
      stream.once(STR_END, () => {
        if (this.fsw.closed) {
          stream = void 0;
          return;
        }
        const wasThrottled = throttler ? throttler.clear() : false;
        resolve2(void 0);
        previous.getChildren().filter((item) => {
          return item !== directory && !current.has(item);
        }).forEach((item) => {
          this.fsw._remove(directory, item);
        });
        stream = void 0;
        if (wasThrottled)
          this._handleRead(directory, false, wh, target, dir, depth, throttler);
      });
    });
  }
  /**
   * Read directory to add / remove files from `@watched` list and re-read it on change.
   * @param dir fs path
   * @param stats
   * @param initialAdd
   * @param depth relative to user-supplied path
   * @param target child path targeted for watch
   * @param wh Common watch helpers for this path
   * @param realpath
   * @returns closer for the watcher instance.
   */
  async _handleDir(dir, stats, initialAdd, depth, target, wh, realpath2) {
    const parentDir = this.fsw._getWatchedDir(sp.dirname(dir));
    const tracked = parentDir.has(sp.basename(dir));
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !target && !tracked) {
      this.fsw._emit(EV.ADD_DIR, dir, stats);
    }
    parentDir.add(sp.basename(dir));
    this.fsw._getWatchedDir(dir);
    let throttler;
    let closer;
    const oDepth = this.fsw.options.depth;
    if ((oDepth == null || depth <= oDepth) && !this.fsw._symlinkPaths.has(realpath2)) {
      if (!target) {
        await this._handleRead(dir, initialAdd, wh, target, dir, depth, throttler);
        if (this.fsw.closed)
          return;
      }
      closer = this._watchWithNodeFs(dir, (dirPath, stats2) => {
        if (stats2 && stats2.mtimeMs === 0)
          return;
        this._handleRead(dirPath, false, wh, target, dir, depth, throttler);
      });
    }
    return closer;
  }
  /**
   * Handle added file, directory, or glob pattern.
   * Delegates call to _handleFile / _handleDir after checks.
   * @param path to file or ir
   * @param initialAdd was the file added at watch instantiation?
   * @param priorWh depth relative to user-supplied path
   * @param depth Child path actually targeted for watch
   * @param target Child path actually targeted for watch
   */
  async _addToNodeFs(path, initialAdd, priorWh, depth, target) {
    const ready = this.fsw._emitReady;
    if (this.fsw._isIgnored(path) || this.fsw.closed) {
      ready();
      return false;
    }
    const wh = this.fsw._getWatchHelpers(path);
    if (priorWh) {
      wh.filterPath = (entry) => priorWh.filterPath(entry);
      wh.filterDir = (entry) => priorWh.filterDir(entry);
    }
    try {
      const stats = await statMethods[wh.statMethod](wh.watchPath);
      if (this.fsw.closed)
        return;
      if (this.fsw._isIgnored(wh.watchPath, stats)) {
        ready();
        return false;
      }
      const follow = this.fsw.options.followSymlinks;
      let closer;
      if (stats.isDirectory()) {
        const absPath = sp.resolve(path);
        const targetPath = follow ? await realpath(path) : path;
        if (this.fsw.closed)
          return;
        closer = await this._handleDir(wh.watchPath, stats, initialAdd, depth, target, wh, targetPath);
        if (this.fsw.closed)
          return;
        if (absPath !== targetPath && targetPath !== void 0) {
          this.fsw._symlinkPaths.set(absPath, targetPath);
        }
      } else if (stats.isSymbolicLink()) {
        const targetPath = follow ? await realpath(path) : path;
        if (this.fsw.closed)
          return;
        const parent = sp.dirname(wh.watchPath);
        this.fsw._getWatchedDir(parent).add(wh.watchPath);
        this.fsw._emit(EV.ADD, wh.watchPath, stats);
        closer = await this._handleDir(parent, stats, initialAdd, depth, path, wh, targetPath);
        if (this.fsw.closed)
          return;
        if (targetPath !== void 0) {
          this.fsw._symlinkPaths.set(sp.resolve(path), targetPath);
        }
      } else {
        closer = this._handleFile(wh.watchPath, stats, initialAdd);
      }
      ready();
      if (closer)
        this.fsw._addPathCloser(path, closer);
      return false;
    } catch (error) {
      if (this.fsw._handleError(error)) {
        ready();
        return path;
      }
    }
  }
}
/*! chokidar - MIT License (c) 2012 Paul Miller (paulmillr.com) */
const SLASH = "/";
const SLASH_SLASH = "//";
const ONE_DOT = ".";
const TWO_DOTS = "..";
const STRING_TYPE = "string";
const BACK_SLASH_RE = /\\/g;
const DOUBLE_SLASH_RE = /\/\//g;
const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
const REPLACER_RE = /^\.[/\\]/;
function arrify(item) {
  return Array.isArray(item) ? item : [item];
}
const isMatcherObject = (matcher) => typeof matcher === "object" && matcher !== null && !(matcher instanceof RegExp);
function createPattern(matcher) {
  if (typeof matcher === "function")
    return matcher;
  if (typeof matcher === "string")
    return (string) => matcher === string;
  if (matcher instanceof RegExp)
    return (string) => matcher.test(string);
  if (typeof matcher === "object" && matcher !== null) {
    return (string) => {
      if (matcher.path === string)
        return true;
      if (matcher.recursive) {
        const relative2 = sp.relative(matcher.path, string);
        if (!relative2) {
          return false;
        }
        return !relative2.startsWith("..") && !sp.isAbsolute(relative2);
      }
      return false;
    };
  }
  return () => false;
}
function normalizePath(path) {
  if (typeof path !== "string")
    throw new Error("string expected");
  path = sp.normalize(path);
  path = path.replace(/\\/g, "/");
  let prepend = false;
  if (path.startsWith("//"))
    prepend = true;
  path = path.replace(DOUBLE_SLASH_RE, "/");
  if (prepend)
    path = "/" + path;
  return path;
}
function matchPatterns(patterns, testString, stats) {
  const path = normalizePath(testString);
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (pattern(path, stats)) {
      return true;
    }
  }
  return false;
}
function anymatch(matchers, testString) {
  if (matchers == null) {
    throw new TypeError("anymatch: specify first argument");
  }
  const matchersArray = arrify(matchers);
  const patterns = matchersArray.map((matcher) => createPattern(matcher));
  {
    return (testString2, stats) => {
      return matchPatterns(patterns, testString2, stats);
    };
  }
}
const unifyPaths = (paths_) => {
  const paths = arrify(paths_).flat();
  if (!paths.every((p) => typeof p === STRING_TYPE)) {
    throw new TypeError(`Non-string provided as watch path: ${paths}`);
  }
  return paths.map(normalizePathToUnix);
};
const toUnix = (string) => {
  let str = string.replace(BACK_SLASH_RE, SLASH);
  let prepend = false;
  if (str.startsWith(SLASH_SLASH)) {
    prepend = true;
  }
  str = str.replace(DOUBLE_SLASH_RE, SLASH);
  if (prepend) {
    str = SLASH + str;
  }
  return str;
};
const normalizePathToUnix = (path) => toUnix(sp.normalize(toUnix(path)));
const normalizeIgnored = (cwd = "") => (path) => {
  if (typeof path === "string") {
    return normalizePathToUnix(sp.isAbsolute(path) ? path : sp.join(cwd, path));
  } else {
    return path;
  }
};
const getAbsolutePath = (path, cwd) => {
  if (sp.isAbsolute(path)) {
    return path;
  }
  return sp.join(cwd, path);
};
const EMPTY_SET = Object.freeze(/* @__PURE__ */ new Set());
class DirEntry {
  constructor(dir, removeWatcher) {
    __publicField(this, "path");
    __publicField(this, "_removeWatcher");
    __publicField(this, "items");
    this.path = dir;
    this._removeWatcher = removeWatcher;
    this.items = /* @__PURE__ */ new Set();
  }
  add(item) {
    const { items } = this;
    if (!items)
      return;
    if (item !== ONE_DOT && item !== TWO_DOTS)
      items.add(item);
  }
  async remove(item) {
    const { items } = this;
    if (!items)
      return;
    items.delete(item);
    if (items.size > 0)
      return;
    const dir = this.path;
    try {
      await readdir(dir);
    } catch (err) {
      if (this._removeWatcher) {
        this._removeWatcher(sp.dirname(dir), sp.basename(dir));
      }
    }
  }
  has(item) {
    const { items } = this;
    if (!items)
      return;
    return items.has(item);
  }
  getChildren() {
    const { items } = this;
    if (!items)
      return [];
    return [...items.values()];
  }
  dispose() {
    this.items.clear();
    this.path = "";
    this._removeWatcher = EMPTY_FN;
    this.items = EMPTY_SET;
    Object.freeze(this);
  }
}
const STAT_METHOD_F = "stat";
const STAT_METHOD_L = "lstat";
class WatchHelper {
  constructor(path, follow, fsw) {
    __publicField(this, "fsw");
    __publicField(this, "path");
    __publicField(this, "watchPath");
    __publicField(this, "fullWatchPath");
    __publicField(this, "dirParts");
    __publicField(this, "followSymlinks");
    __publicField(this, "statMethod");
    this.fsw = fsw;
    const watchPath = path;
    this.path = path = path.replace(REPLACER_RE, "");
    this.watchPath = watchPath;
    this.fullWatchPath = sp.resolve(watchPath);
    this.dirParts = [];
    this.dirParts.forEach((parts) => {
      if (parts.length > 1)
        parts.pop();
    });
    this.followSymlinks = follow;
    this.statMethod = follow ? STAT_METHOD_F : STAT_METHOD_L;
  }
  entryPath(entry) {
    return sp.join(this.watchPath, sp.relative(this.watchPath, entry.fullPath));
  }
  filterPath(entry) {
    const { stats } = entry;
    if (stats && stats.isSymbolicLink())
      return this.filterDir(entry);
    const resolvedPath = this.entryPath(entry);
    return this.fsw._isntIgnored(resolvedPath, stats) && this.fsw._hasReadPermissions(stats);
  }
  filterDir(entry) {
    return this.fsw._isntIgnored(this.entryPath(entry), entry.stats);
  }
}
class FSWatcher extends EventEmitter {
  // Not indenting methods for history sake; for now.
  constructor(_opts = {}) {
    super();
    __publicField(this, "closed");
    __publicField(this, "options");
    __publicField(this, "_closers");
    __publicField(this, "_ignoredPaths");
    __publicField(this, "_throttled");
    __publicField(this, "_streams");
    __publicField(this, "_symlinkPaths");
    __publicField(this, "_watched");
    __publicField(this, "_pendingWrites");
    __publicField(this, "_pendingUnlinks");
    __publicField(this, "_readyCount");
    __publicField(this, "_emitReady");
    __publicField(this, "_closePromise");
    __publicField(this, "_userIgnored");
    __publicField(this, "_readyEmitted");
    __publicField(this, "_emitRaw");
    __publicField(this, "_boundRemove");
    __publicField(this, "_nodeFsHandler");
    this.closed = false;
    this._closers = /* @__PURE__ */ new Map();
    this._ignoredPaths = /* @__PURE__ */ new Set();
    this._throttled = /* @__PURE__ */ new Map();
    this._streams = /* @__PURE__ */ new Set();
    this._symlinkPaths = /* @__PURE__ */ new Map();
    this._watched = /* @__PURE__ */ new Map();
    this._pendingWrites = /* @__PURE__ */ new Map();
    this._pendingUnlinks = /* @__PURE__ */ new Map();
    this._readyCount = 0;
    this._readyEmitted = false;
    const awf = _opts.awaitWriteFinish;
    const DEF_AWF = { stabilityThreshold: 2e3, pollInterval: 100 };
    const opts = {
      // Defaults
      persistent: true,
      ignoreInitial: false,
      ignorePermissionErrors: false,
      interval: 100,
      binaryInterval: 300,
      followSymlinks: true,
      usePolling: false,
      // useAsync: false,
      atomic: true,
      // NOTE: overwritten later (depends on usePolling)
      ..._opts,
      // Change format
      ignored: _opts.ignored ? arrify(_opts.ignored) : arrify([]),
      awaitWriteFinish: awf === true ? DEF_AWF : typeof awf === "object" ? { ...DEF_AWF, ...awf } : false
    };
    if (isIBMi)
      opts.usePolling = true;
    if (opts.atomic === void 0)
      opts.atomic = !opts.usePolling;
    const envPoll = process.env.CHOKIDAR_USEPOLLING;
    if (envPoll !== void 0) {
      const envLower = envPoll.toLowerCase();
      if (envLower === "false" || envLower === "0")
        opts.usePolling = false;
      else if (envLower === "true" || envLower === "1")
        opts.usePolling = true;
      else
        opts.usePolling = !!envLower;
    }
    const envInterval = process.env.CHOKIDAR_INTERVAL;
    if (envInterval)
      opts.interval = Number.parseInt(envInterval, 10);
    let readyCalls = 0;
    this._emitReady = () => {
      readyCalls++;
      if (readyCalls >= this._readyCount) {
        this._emitReady = EMPTY_FN;
        this._readyEmitted = true;
        process.nextTick(() => this.emit(EVENTS.READY));
      }
    };
    this._emitRaw = (...args) => this.emit(EVENTS.RAW, ...args);
    this._boundRemove = this._remove.bind(this);
    this.options = opts;
    this._nodeFsHandler = new NodeFsHandler(this);
    Object.freeze(opts);
  }
  _addIgnoredPath(matcher) {
    if (isMatcherObject(matcher)) {
      for (const ignored of this._ignoredPaths) {
        if (isMatcherObject(ignored) && ignored.path === matcher.path && ignored.recursive === matcher.recursive) {
          return;
        }
      }
    }
    this._ignoredPaths.add(matcher);
  }
  _removeIgnoredPath(matcher) {
    this._ignoredPaths.delete(matcher);
    if (typeof matcher === "string") {
      for (const ignored of this._ignoredPaths) {
        if (isMatcherObject(ignored) && ignored.path === matcher) {
          this._ignoredPaths.delete(ignored);
        }
      }
    }
  }
  // Public methods
  /**
   * Adds paths to be watched on an existing FSWatcher instance.
   * @param paths_ file or file list. Other arguments are unused
   */
  add(paths_, _origAdd, _internal) {
    const { cwd } = this.options;
    this.closed = false;
    this._closePromise = void 0;
    let paths = unifyPaths(paths_);
    if (cwd) {
      paths = paths.map((path) => {
        const absPath = getAbsolutePath(path, cwd);
        return absPath;
      });
    }
    paths.forEach((path) => {
      this._removeIgnoredPath(path);
    });
    this._userIgnored = void 0;
    if (!this._readyCount)
      this._readyCount = 0;
    this._readyCount += paths.length;
    Promise.all(paths.map(async (path) => {
      const res = await this._nodeFsHandler._addToNodeFs(path, !_internal, void 0, 0, _origAdd);
      if (res)
        this._emitReady();
      return res;
    })).then((results) => {
      if (this.closed)
        return;
      results.forEach((item) => {
        if (item)
          this.add(sp.dirname(item), sp.basename(_origAdd || item));
      });
    });
    return this;
  }
  /**
   * Close watchers or start ignoring events from specified paths.
   */
  unwatch(paths_) {
    if (this.closed)
      return this;
    const paths = unifyPaths(paths_);
    const { cwd } = this.options;
    paths.forEach((path) => {
      if (!sp.isAbsolute(path) && !this._closers.has(path)) {
        if (cwd)
          path = sp.join(cwd, path);
        path = sp.resolve(path);
      }
      this._closePath(path);
      this._addIgnoredPath(path);
      if (this._watched.has(path)) {
        this._addIgnoredPath({
          path,
          recursive: true
        });
      }
      this._userIgnored = void 0;
    });
    return this;
  }
  /**
   * Close watchers and remove all listeners from watched paths.
   */
  close() {
    if (this._closePromise) {
      return this._closePromise;
    }
    this.closed = true;
    this.removeAllListeners();
    const closers = [];
    this._closers.forEach((closerList) => closerList.forEach((closer) => {
      const promise = closer();
      if (promise instanceof Promise)
        closers.push(promise);
    }));
    this._streams.forEach((stream) => stream.destroy());
    this._userIgnored = void 0;
    this._readyCount = 0;
    this._readyEmitted = false;
    this._watched.forEach((dirent) => dirent.dispose());
    this._closers.clear();
    this._watched.clear();
    this._streams.clear();
    this._symlinkPaths.clear();
    this._throttled.clear();
    this._closePromise = closers.length ? Promise.all(closers).then(() => void 0) : Promise.resolve();
    return this._closePromise;
  }
  /**
   * Expose list of watched paths
   * @returns for chaining
   */
  getWatched() {
    const watchList = {};
    this._watched.forEach((entry, dir) => {
      const key = this.options.cwd ? sp.relative(this.options.cwd, dir) : dir;
      const index = key || ONE_DOT;
      watchList[index] = entry.getChildren().sort();
    });
    return watchList;
  }
  emitWithAll(event, args) {
    this.emit(event, ...args);
    if (event !== EVENTS.ERROR)
      this.emit(EVENTS.ALL, event, ...args);
  }
  // Common helpers
  // --------------
  /**
   * Normalize and emit events.
   * Calling _emit DOES NOT MEAN emit() would be called!
   * @param event Type of event
   * @param path File or directory path
   * @param stats arguments to be passed with event
   * @returns the error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  async _emit(event, path, stats) {
    if (this.closed)
      return;
    const opts = this.options;
    if (isWindows)
      path = sp.normalize(path);
    if (opts.cwd)
      path = sp.relative(opts.cwd, path);
    const args = [path];
    if (stats != null)
      args.push(stats);
    const awf = opts.awaitWriteFinish;
    let pw;
    if (awf && (pw = this._pendingWrites.get(path))) {
      pw.lastChange = /* @__PURE__ */ new Date();
      return this;
    }
    if (opts.atomic) {
      if (event === EVENTS.UNLINK) {
        this._pendingUnlinks.set(path, [event, ...args]);
        setTimeout(() => {
          this._pendingUnlinks.forEach((entry, path2) => {
            this.emit(...entry);
            this.emit(EVENTS.ALL, ...entry);
            this._pendingUnlinks.delete(path2);
          });
        }, typeof opts.atomic === "number" ? opts.atomic : 100);
        return this;
      }
      if (event === EVENTS.ADD && this._pendingUnlinks.has(path)) {
        event = EVENTS.CHANGE;
        this._pendingUnlinks.delete(path);
      }
    }
    if (awf && (event === EVENTS.ADD || event === EVENTS.CHANGE) && this._readyEmitted) {
      const awfEmit = (err, stats2) => {
        if (err) {
          event = EVENTS.ERROR;
          args[0] = err;
          this.emitWithAll(event, args);
        } else if (stats2) {
          if (args.length > 1) {
            args[1] = stats2;
          } else {
            args.push(stats2);
          }
          this.emitWithAll(event, args);
        }
      };
      this._awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit);
      return this;
    }
    if (event === EVENTS.CHANGE) {
      const isThrottled = !this._throttle(EVENTS.CHANGE, path, 50);
      if (isThrottled)
        return this;
    }
    if (opts.alwaysStat && stats === void 0 && (event === EVENTS.ADD || event === EVENTS.ADD_DIR || event === EVENTS.CHANGE)) {
      const fullPath = opts.cwd ? sp.join(opts.cwd, path) : path;
      let stats2;
      try {
        stats2 = await stat(fullPath);
      } catch (err) {
      }
      if (!stats2 || this.closed)
        return;
      args.push(stats2);
    }
    this.emitWithAll(event, args);
    return this;
  }
  /**
   * Common handler for errors
   * @returns The error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  _handleError(error) {
    const code = error && error.code;
    if (error && code !== "ENOENT" && code !== "ENOTDIR" && (!this.options.ignorePermissionErrors || code !== "EPERM" && code !== "EACCES")) {
      this.emit(EVENTS.ERROR, error);
    }
    return error || this.closed;
  }
  /**
   * Helper utility for throttling
   * @param actionType type being throttled
   * @param path being acted upon
   * @param timeout duration of time to suppress duplicate actions
   * @returns tracking object or false if action should be suppressed
   */
  _throttle(actionType, path, timeout) {
    if (!this._throttled.has(actionType)) {
      this._throttled.set(actionType, /* @__PURE__ */ new Map());
    }
    const action = this._throttled.get(actionType);
    if (!action)
      throw new Error("invalid throttle");
    const actionPath = action.get(path);
    if (actionPath) {
      actionPath.count++;
      return false;
    }
    let timeoutObject;
    const clear = () => {
      const item = action.get(path);
      const count = item ? item.count : 0;
      action.delete(path);
      clearTimeout(timeoutObject);
      if (item)
        clearTimeout(item.timeoutObject);
      return count;
    };
    timeoutObject = setTimeout(clear, timeout);
    const thr = { timeoutObject, clear, count: 0 };
    action.set(path, thr);
    return thr;
  }
  _incrReadyCount() {
    return this._readyCount++;
  }
  /**
   * Awaits write operation to finish.
   * Polls a newly created file for size variations. When files size does not change for 'threshold' milliseconds calls callback.
   * @param path being acted upon
   * @param threshold Time in milliseconds a file size must be fixed before acknowledging write OP is finished
   * @param event
   * @param awfEmit Callback to be called when ready for event to be emitted.
   */
  _awaitWriteFinish(path, threshold, event, awfEmit) {
    const awf = this.options.awaitWriteFinish;
    if (typeof awf !== "object")
      return;
    const pollInterval = awf.pollInterval;
    let timeoutHandler;
    let fullPath = path;
    if (this.options.cwd && !sp.isAbsolute(path)) {
      fullPath = sp.join(this.options.cwd, path);
    }
    const now = /* @__PURE__ */ new Date();
    const writes = this._pendingWrites;
    function awaitWriteFinishFn(prevStat) {
      stat$1(fullPath, (err, curStat) => {
        if (err || !writes.has(path)) {
          if (err && err.code !== "ENOENT")
            awfEmit(err);
          return;
        }
        const now2 = Number(/* @__PURE__ */ new Date());
        if (prevStat && curStat.size !== prevStat.size) {
          writes.get(path).lastChange = now2;
        }
        const pw = writes.get(path);
        const df = now2 - pw.lastChange;
        if (df >= threshold) {
          writes.delete(path);
          awfEmit(void 0, curStat);
        } else {
          timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval, curStat);
        }
      });
    }
    if (!writes.has(path)) {
      writes.set(path, {
        lastChange: now,
        cancelWait: () => {
          writes.delete(path);
          clearTimeout(timeoutHandler);
          return event;
        }
      });
      timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval);
    }
  }
  /**
   * Determines whether user has asked to ignore this path.
   */
  _isIgnored(path, stats) {
    if (this.options.atomic && DOT_RE.test(path))
      return true;
    if (!this._userIgnored) {
      const { cwd } = this.options;
      const ign = this.options.ignored;
      const ignored = (ign || []).map(normalizeIgnored(cwd));
      const ignoredPaths = [...this._ignoredPaths];
      const list = [...ignoredPaths.map(normalizeIgnored(cwd)), ...ignored];
      this._userIgnored = anymatch(list);
    }
    return this._userIgnored(path, stats);
  }
  _isntIgnored(path, stat2) {
    return !this._isIgnored(path, stat2);
  }
  /**
   * Provides a set of common helpers and properties relating to symlink handling.
   * @param path file or directory pattern being watched
   */
  _getWatchHelpers(path) {
    return new WatchHelper(path, this.options.followSymlinks, this);
  }
  // Directory helpers
  // -----------------
  /**
   * Provides directory tracking objects
   * @param directory path of the directory
   */
  _getWatchedDir(directory) {
    const dir = sp.resolve(directory);
    if (!this._watched.has(dir))
      this._watched.set(dir, new DirEntry(dir, this._boundRemove));
    return this._watched.get(dir);
  }
  // File helpers
  // ------------
  /**
   * Check for read permissions: https://stackoverflow.com/a/11781404/1358405
   */
  _hasReadPermissions(stats) {
    if (this.options.ignorePermissionErrors)
      return true;
    return Boolean(Number(stats.mode) & 256);
  }
  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   * @param directory within which the following item is located
   * @param item      base path of item/directory
   */
  _remove(directory, item, isDirectory) {
    const path = sp.join(directory, item);
    const fullPath = sp.resolve(path);
    isDirectory = isDirectory != null ? isDirectory : this._watched.has(path) || this._watched.has(fullPath);
    if (!this._throttle("remove", path, 100))
      return;
    if (!isDirectory && this._watched.size === 1) {
      this.add(directory, item, true);
    }
    const wp = this._getWatchedDir(path);
    const nestedDirectoryChildren = wp.getChildren();
    nestedDirectoryChildren.forEach((nested) => this._remove(path, nested));
    const parent = this._getWatchedDir(directory);
    const wasTracked = parent.has(item);
    parent.remove(item);
    if (this._symlinkPaths.has(fullPath)) {
      this._symlinkPaths.delete(fullPath);
    }
    let relPath = path;
    if (this.options.cwd)
      relPath = sp.relative(this.options.cwd, path);
    if (this.options.awaitWriteFinish && this._pendingWrites.has(relPath)) {
      const event = this._pendingWrites.get(relPath).cancelWait();
      if (event === EVENTS.ADD)
        return;
    }
    this._watched.delete(path);
    this._watched.delete(fullPath);
    const eventName = isDirectory ? EVENTS.UNLINK_DIR : EVENTS.UNLINK;
    if (wasTracked && !this._isIgnored(path))
      this._emit(eventName, path);
    this._closePath(path);
  }
  /**
   * Closes all watchers for a path
   */
  _closePath(path) {
    this._closeFile(path);
    const dir = sp.dirname(path);
    this._getWatchedDir(dir).remove(sp.basename(path));
  }
  /**
   * Closes only file-specific watchers
   */
  _closeFile(path) {
    const closers = this._closers.get(path);
    if (!closers)
      return;
    closers.forEach((closer) => closer());
    this._closers.delete(path);
  }
  _addPathCloser(path, closer) {
    if (!closer)
      return;
    let list = this._closers.get(path);
    if (!list) {
      list = [];
      this._closers.set(path, list);
    }
    list.push(closer);
  }
  _readdirp(root, opts) {
    if (this.closed)
      return;
    const options = { type: EVENTS.ALL, alwaysStat: true, lstat: true, ...opts, depth: 0 };
    let stream = readdirp(root, options);
    this._streams.add(stream);
    stream.once(STR_CLOSE, () => {
      stream = void 0;
    });
    stream.once(STR_END, () => {
      if (stream) {
        this._streams.delete(stream);
        stream = void 0;
      }
    });
    return stream;
  }
}
function watch(paths, options = {}) {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
}
const chokidar = { watch, FSWatcher };
const __dirname$2 = sp__default.dirname(fileURLToPath(import.meta.url));
class VaultManager {
  constructor(mainWindow) {
    __publicField(this, "watcher", null);
    __publicField(this, "vaultPath", null);
    __publicField(this, "mainWindow", null);
    // In-memory representation of the graph
    __publicField(this, "nodes", /* @__PURE__ */ new Map());
    __publicField(this, "edges", /* @__PURE__ */ new Set());
    // Stored as "source|target"
    // Debounce timer for graph broadcasts
    __publicField(this, "broadcastTimer", null);
    this.mainWindow = mainWindow;
  }
  setMainWindow(window) {
    this.mainWindow = window;
  }
  async init() {
    const envManager2 = new EnvManager();
    const config = await envManager2.readEnv();
    this.vaultPath = config.VAULT_PATH || sp__default.resolve(__dirname$2, "../../../.vault");
    try {
      await fs.access(this.vaultPath);
    } catch {
      console.log(`[VaultManager] Vault path does not exist: ${this.vaultPath}`);
      return;
    }
    console.log(`[VaultManager] Initializing watch on: ${this.vaultPath}`);
    this.watcher = chokidar.watch("**/*.md", {
      cwd: this.vaultPath,
      ignored: /(^|[\/\\])\./,
      // ignore dotfiles
      persistent: true
    });
    this.watcher.on("add", async (filePath) => {
      await this.processFile(filePath);
      this.broadcastUpdate("add", filePath);
      this.scheduleBroadcastGraph();
    }).on("change", async (filePath) => {
      await this.processFile(filePath);
      this.broadcastUpdate("change", filePath);
      this.scheduleBroadcastGraph();
    }).on("unlink", (filePath) => {
      this.removeFile(filePath);
      this.broadcastUpdate("unlink", filePath);
      this.scheduleBroadcastGraph();
    });
  }
  stop() {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
  /** Schedule a debounced graph broadcast (coalesces rapid file changes) */
  scheduleBroadcastGraph() {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      this.broadcastGraph();
      this.broadcastTimer = null;
    }, 500);
  }
  async processFile(relativePath) {
    if (!this.vaultPath) return;
    const fullPath = sp__default.join(this.vaultPath, relativePath);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const title = sp__default.basename(relativePath, ".md");
      const id = this.normalizeId(title);
      const tags = [];
      const tagRegex = /(?:^|\s)#([a-zA-Z0-9_-]+)/g;
      let match;
      while ((match = tagRegex.exec(content)) !== null) {
        if (!tags.includes(match[1])) tags.push(match[1]);
      }
      this.nodes.set(id, { id, title, tags });
      const edgesToRemove = Array.from(this.edges).filter((e) => e.startsWith(`${id}|`));
      edgesToRemove.forEach((e) => this.edges.delete(e));
      const linkRegex = /\[\[(.*?)\]\]/g;
      while ((match = linkRegex.exec(content)) !== null) {
        const linkTarget = match[1].split("|")[0].trim();
        const targetId = this.normalizeId(linkTarget);
        if (targetId) {
          this.edges.add(`${id}|${targetId}`);
        }
      }
    } catch (err) {
      console.error(`[VaultManager] Failed to process ${relativePath}:`, err);
    }
  }
  removeFile(relativePath) {
    const title = sp__default.basename(relativePath, ".md");
    const id = this.normalizeId(title);
    this.nodes.delete(id);
    const edgesToRemove = Array.from(this.edges).filter((e) => e.startsWith(`${id}|`) || e.endsWith(`|${id}`));
    edgesToRemove.forEach((e) => this.edges.delete(e));
  }
  normalizeId(name) {
    return name.toLowerCase().replace(/\s+/g, "-");
  }
  broadcastUpdate(event, filePath) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const payload = {
        event,
        path: filePath,
        timestamp: Date.now()
      };
      this.mainWindow.webContents.send(IPC.VAULT_UPDATE, payload);
    }
  }
  broadcastGraph() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const payload = {
        nodes: Array.from(this.nodes.values()),
        edges: Array.from(this.edges).map((e) => {
          const [source, target] = e.split("|");
          return { source, target };
        })
      };
      this.mainWindow.webContents.send(IPC.VAULT_GRAPH_UPDATE, payload);
    }
  }
  getGraph() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges).map((e) => {
        const [source, target] = e.split("|");
        return { source, target };
      })
    };
  }
}
const vaultManager = new VaultManager(null);
const LAYOUTS_DIR = () => sp__default.join(app.getPath("userData"), "layouts");
const LAYOUT_FILE = () => sp__default.join(LAYOUTS_DIR(), "layout.json");
async function loadLayout() {
  try {
    const raw = await fs.readFile(LAYOUT_FILE(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function saveLayout(payload) {
  try {
    const dir = LAYOUTS_DIR();
    await fs.mkdir(dir, { recursive: true });
    const file = LAYOUT_FILE();
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf-8");
    await fs.rename(tmp, file);
    return true;
  } catch (err) {
    console.error("[LayoutManager] Failed to save layout:", err);
    return false;
  }
}
let saveDebounceTimer = null;
function setupIpcHandlers(mainWindow) {
  ipcMain.handle(IPC.START_DAEMON, async () => {
    return daemonManager.start(mainWindow);
  });
  ipcMain.handle(IPC.STOP_DAEMON, async () => {
    return daemonManager.stop();
  });
  ipcMain.handle(IPC.SAVE_ENV_CONFIG, async (_, config) => {
    return await envManager.writeEnv(config);
  });
  ipcMain.handle(IPC.GET_ENV_CONFIG, async () => {
    return await envManager.readEnv();
  });
  ipcMain.handle(IPC.CHECK_DEPENDENCIES, async () => {
    return await daemonManager.checkDependencies();
  });
  ipcMain.handle(IPC.GET_VAULT_PATH, async () => {
    return await envManager.getVaultPath();
  });
  ipcMain.handle(IPC.GET_VAULT_GRAPH, async () => {
    return vaultManager.getGraph();
  });
  ipcMain.handle(IPC.TRIGGER_WORKFLOW, async (_, name) => {
    return await daemonManager.triggerWorkflow(name);
  });
  ipcMain.handle(IPC.LOAD_LAYOUT, async () => {
    return await loadLayout();
  });
  ipcMain.handle(IPC.SAVE_LAYOUT, async (_, layout) => {
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    return new Promise((resolve2) => {
      saveDebounceTimer = setTimeout(async () => {
        const result = await saveLayout(layout);
        resolve2(result);
      }, 500);
    });
  });
}
const __dirname$1 = sp__default.dirname(fileURLToPath(import.meta.url));
app.setName("Agent HQ Control Center");
process.env.APP_ROOT = sp__default.join(__dirname$1, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const MAIN_DIST = sp__default.join(process.env.APP_ROOT, "dist-electron");
const RENDERER_DIST = sp__default.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? sp__default.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
let win;
let statsTimer = null;
let lastCpuInfo = os.cpus();
function getCpuUsagePercent() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  let prevTotalIdle = 0, prevTotalTick = 0;
  for (let i = 0; i < cpus.length; i++) {
    const cpu = cpus[i];
    const prev = lastCpuInfo[i];
    for (const type2 of Object.keys(cpu.times)) {
      totalTick += cpu.times[type2];
      prevTotalTick += prev.times[type2];
    }
    totalIdle += cpu.times.idle;
    prevTotalIdle += prev.times.idle;
  }
  lastCpuInfo = cpus;
  const idleDiff = totalIdle - prevTotalIdle;
  const totalDiff = totalTick - prevTotalTick;
  if (totalDiff === 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 100);
}
function startSystemStatsPolling(window) {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(() => {
    if (window.isDestroyed()) {
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = null;
      return;
    }
    const totalMem = Math.round(os.totalmem() / (1024 * 1024));
    const freeMem = Math.round(os.freemem() / (1024 * 1024));
    const usedMem = totalMem - freeMem;
    window.webContents.send(IPC.SYSTEM_STATS, {
      cpuUsagePercent: getCpuUsagePercent(),
      memUsedMB: usedMem,
      memTotalMB: totalMem
    });
  }, 3e3);
}
function createWindow() {
  const iconPath = sp__default.join(process.env.VITE_PUBLIC, "icon-color.png");
  const appIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIcon);
  }
  win = new BrowserWindow({
    title: "Agent HQ Control Center",
    icon: appIcon,
    webPreferences: {
      preload: sp__default.join(__dirname$1, "preload.mjs"),
      // Security hardening
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  win.webContents.on("did-finish-load", () => {
    if (!win) return;
    startSystemStatsPolling(win);
    console.log("[Main] Auto-starting daemon...");
    daemonManager.start(win);
  });
  win.on("closed", () => {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  });
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(sp__default.join(RENDERER_DIST, "index.html"));
  }
  setupIpcHandlers(win);
  vaultManager.setMainWindow(win);
  vaultManager.init();
}
app.on("window-all-closed", () => {
  vaultManager.stop();
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});
app.on("before-quit", () => {
  vaultManager.stop();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            // unsafe-inline needed for Vite HMR in dev
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: blob:",
            "connect-src 'self' ws://localhost:18900 http://localhost:18900"
          ].join("; ")
        ]
      }
    });
  });
  createWindow();
});
export {
  MAIN_DIST,
  RENDERER_DIST,
  VITE_DEV_SERVER_URL
};
