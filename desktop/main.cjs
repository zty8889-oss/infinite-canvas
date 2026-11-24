const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const updater = require("./updater.cjs");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PRODUCT_NAME = "无限画布";
const DEFAULT_PORT = 43621;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const API_PREFIX = "/infinite-canvas/ark-proxy";
const MODEL_PROXY_PATH = "/infinite-canvas/model-proxy";
const PROVIDER_PROXY_PATH = "/infinite-canvas/provider-proxy";
const APP_ROOT = app.getAppPath();
const MEDIA_TYPES = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/flac": "flac",
  "audio/l16": "pcm"
});
const MEDIA_MIME_TYPES = Object.freeze(Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([mime, extension]) => [extension, mime])
));
let localServer;
let mainWindow;
const updateState = {
  status: "idle",
  currentVersion: app.getVersion(),
  availableVersion: "",
  percent: 0,
  speed: 0,
  error: "",
  readyFile: "",
  manualUrl: "https://github.com/zty8889-oss/infinite-canvas/releases/latest"
};

const UPDATE_PAGE = "https://github.com/zty8889-oss/infinite-canvas/releases/latest";
let updateTask = null;

async function beginUpdateCheck() {
  if (updateTask) return updateTask;
  updateState.status = "checking";
  updateState.error = "";
  updateState.percent = 0;
  updateState.availableVersion = "";
  updateState.readyFile = "";
  updateTask = (async () => {
    try {
      const latest = await updater.fetchLatest();
      if (!updater.isNewer(latest.version, app.getVersion())) {
        updateState.status = "current";
        return;
      }
      updateState.availableVersion = latest.version;
      updateState.status = "downloading";
      const directory = path.join(app.getPath("userData"), "updates");
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, latest.asset.name);
      await updater.download(latest, file, (percent, received, speed) => {
        updateState.percent = Math.max(0, Math.min(99, percent || 0));
        updateState.speed = speed || 0;
      });
      updateState.percent = 100;
      updateState.readyFile = file;
      updateState.status = "downloaded";
    } catch (error) {
      updateState.status = "error";
      updateState.percent = 0;
      const raw = String(error && error.message || error || "更新检查失败");
      if (/SLOW_NETWORK/.test(raw)) {
        const speed = Math.round((updateState.speed || 0) / 1024);
        updateState.error = ("当前网络到 GitHub 下载服务器过慢（约 " + speed + " KB/s），已停止下载。请手动下载安装包：" + UPDATE_PAGE).slice(0, 500);
      } else {
        updateState.error = (raw + "（可手动下载：" + UPDATE_PAGE + "）").slice(0, 500);
      }
    } finally {
      updateTask = null;
    }
  })();
  return updateTask;
}

function installDownloadedUpdate() {
  if (!updateState.readyFile || !fs.existsSync(updateState.readyFile)) {
    throw new Error("更新包不存在，请重新检查更新");
  }
  const child = spawn(updateState.readyFile, [], { detached: true, stdio: "ignore" });
  child.unref();
  setTimeout(() => app.quit(), 400);
}

app.setName(PRODUCT_NAME);
app.setPath("userData", process.env.IC_USER_DATA || path.join(app.getPath("appData"), "InfiniteCanvasDesktop"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const port = await startLocalServer();
      createWindow(port);
    } catch (error) {
      dialog.showErrorBox(PRODUCT_NAME, "桌面服务启动失败：" + error.message);
      app.quit();
    }
  });
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function mediaPathname(pathname) {
  const match = pathname.match(/^\/infinite-canvas\/media\/([0-9a-f-]{36})\.(jpg|png|webp|gif|avif|mp4|webm|mov|ogv|mp3|wav|ogg|m4a|flac|pcm)$/i);
  return match ? { file: match[1].toLowerCase() + "." + match[2].toLowerCase(), extension: match[2].toLowerCase() } : null;
}

function mediaOriginAllowed(request, port) {
  const expectedOrigin = "http://127.0.0.1:" + port;
  return (!request.headers.origin || request.headers.origin === expectedOrigin)
    && (!request.headers.referer || request.headers.referer.startsWith(expectedOrigin + "/"));
}

async function handleMediaRequest(request, response, pathname, port) {
  if (!mediaOriginAllowed(request, port)) {
    sendJson(response, 403, { error: { message: "仅允许桌面画布访问本地媒体" } });
    return true;
  }

  if (pathname === "/infinite-canvas/media") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: { message: "上传媒体仅支持 POST" } });
      return true;
    }
    const mime = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const extension = MEDIA_TYPES[mime];
    const declaredLength = Number(request.headers["content-length"] || 0);
    if (!extension) {
      sendJson(response, 415, { error: { message: "仅支持常见图片和视频格式" } });
      return true;
    }
    if (declaredLength > MAX_MEDIA_BYTES) {
      sendJson(response, 413, { error: { message: "单个媒体文件不能超过 512 MB" } });
      return true;
    }

    const mediaRoot = path.join(app.getPath("userData"), "media");
    const name = crypto.randomUUID();
    const tempPath = path.join(mediaRoot, name + ".tmp");
    const finalName = name + "." + extension;
    let length = 0;
    try {
      await fs.promises.mkdir(mediaRoot, { recursive: true });
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          length += chunk.length;
          if (length > MAX_MEDIA_BYTES) callback(Object.assign(new Error("单个媒体文件不能超过 512 MB"), { statusCode: 413 }));
          else callback(null, chunk);
        }
      });
      await pipeline(request, limiter, fs.createWriteStream(tempPath, { flags: "wx" }));
      if (!length) throw Object.assign(new Error("上传文件为空"), { statusCode: 400 });
      await fs.promises.rename(tempPath, path.join(mediaRoot, finalName));
      sendJson(response, 201, { url: "media/" + finalName, bytes: length });
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: { message: error.message || "媒体保存失败" } });
      else response.destroy(error);
    }
    return true;
  }

  const media = mediaPathname(pathname);
  if (!media) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: { message: "读取媒体仅支持 GET" } });
    return true;
  }
  const filePath = path.join(app.getPath("userData"), "media", media.file);
  try {
    const stat = await fs.promises.stat(filePath);
    let start = 0, end = stat.size - 1, status = 200;
    const range = request.headers.range;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Accept-Ranges": "bytes" });
        response.end();
        return true;
      }
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      else if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
      if (!match[1]) end = stat.size - 1;
      if (start > end || start >= stat.size) {
        response.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Accept-Ranges": "bytes" });
        response.end();
        return true;
      }
      end = Math.min(end, stat.size - 1);
      status = 206;
    }
    const headers = {
      "Content-Type": MEDIA_MIME_TYPES[media.extension],
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff"
    };
    if (status === 206) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + stat.size;
    response.writeHead(status, headers);
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(filePath, { start, end }).on("error", error => response.destroy(error)).pipe(response);
  } catch {
    sendJson(response, 404, { error: { message: "找不到已上传的媒体文件" } });
  }
  return true;
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function getArkPath(method, pathname) {
  if (method === "GET" && pathname === API_PREFIX + "/models") return "/models";
  if (method === "POST" && pathname === API_PREFIX + "/images/generations") return "/images/generations";
  if (method === "POST" && pathname === API_PREFIX + "/contents/generations/tasks") {
    return "/contents/generations/tasks";
  }
  const task = pathname.match(/^\/infinite-canvas\/ark-proxy\/contents\/generations\/tasks\/([A-Za-z0-9_-]+)$/);
  if (method === "GET" && task) return "/contents/generations/tasks/" + task[1];
  return null;
}

function getModelCatalogTarget(requestUrl) {
  const base = requestUrl.searchParams.get("base");
  const endpoint = requestUrl.searchParams.get("path");
  if (!base || !["/models", "/v1/models"].includes(endpoint)) return null;

  let target;
  try {
    target = new URL(base);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    return null;
  }

  const basePath = target.pathname.replace(/\/+$/, "");
  const modelPath = endpoint === "/v1/models" && /\/v1$/i.test(basePath) ? "/models" : endpoint;
  target.pathname = basePath + modelPath;
  return target;
}

function forwardModelListRequest(request, response, target) {
  const headers = { Accept: "application/json" };
  if (request.headers.authorization) headers.Authorization = request.headers.authorization;
  const encodedHeaders = request.headers["x-infinite-canvas-headers"];
  if (encodedHeaders) {
    if (encodedHeaders.length > 22000) {
      sendJson(response, 400, { error: { message: "额外请求头超出限制" } });
      return;
    }
    try {
      const customHeaders = JSON.parse(Buffer.from(encodedHeaders, "base64").toString("utf8"));
      if (!customHeaders || typeof customHeaders !== "object" || Array.isArray(customHeaders)) throw new Error();
      for (const [name, value] of Object.entries(customHeaders)) {
        const normalized = name.toLowerCase();
        if (!/^[a-z0-9-]{1,100}$/i.test(name)
          || ["host", "content-length", "connection", "transfer-encoding", "proxy-authorization", "origin", "referer"].includes(normalized)
          || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) {
          throw new Error();
        }
        if (normalized === "authorization") headers.Authorization = value;
        else headers[name] = value;
      }
    } catch {
      sendJson(response, 400, { error: { message: "额外请求头格式无效" } });
      return;
    }
  }
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, {
    method: "GET",
    headers,
    timeout: 18000
  }, upstreamResponse => {
    const chunks = [];
    let length = 0;
    upstreamResponse.on("data", chunk => {
      length += chunk.length;
      if (length > 8 * 1024 * 1024) {
        upstream.destroy(new Error("模型列表响应超过 8 MB"));
        return;
      }
      chunks.push(chunk);
    });
    upstreamResponse.on("end", () => {
      const body = Buffer.concat(chunks);
      response.writeHead(upstreamResponse.statusCode || 502, {
        "Content-Type": upstreamResponse.headers["content-type"] || "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(body);
    });
  });

  upstream.on("timeout", () => upstream.destroy(new Error("读取上游模型列表超时")));
  upstream.on("error", error => {
    if (!response.headersSent) sendJson(response, 502, { error: { message: error.message } });
    else response.destroy(error);
  });
  upstream.end();
}

function getProviderProxyTarget(requestUrl) {
  const raw = requestUrl.searchParams.get("url");
  if (!raw || raw.length > 4096) return null;
  let target;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.hash) return null;
  return target;
}

async function forwardProviderRequest(request, response, target) {
  let body;
  try {
    body = request.method === "POST" ? await readRequestBody(request) : undefined;
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: { message: error.message } });
    return;
  }

  const allowed = new Set(["accept", "authorization", "content-type", "xi-api-key", "x-api-key", "x-api-request-id", "x-goog-api-key", "api-key"]);
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (allowed.has(name.toLowerCase()) && typeof value === "string") headers[name] = value;
  }
  if (body) headers["Content-Length"] = body.length;

  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, {
    method: request.method,
    headers,
    timeout: 180000
  }, upstreamResponse => {
    const responseHeaders = {
      "Content-Type": upstreamResponse.headers["content-type"] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    };
    if (upstreamResponse.headers["content-disposition"]) responseHeaders["Content-Disposition"] = upstreamResponse.headers["content-disposition"];
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });

  upstream.on("timeout", () => upstream.destroy(new Error("音频接口请求超时")));
  upstream.on("error", error => {
    if (!response.headersSent) sendJson(response, 502, { error: { message: error.message } });
    else response.destroy(error);
  });
  if (body) upstream.write(body);
  upstream.end();
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let rejected = false;
    request.on("data", chunk => {
      if (rejected) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        rejected = true;
        reject(Object.assign(new Error("请求内容超过 64 MB"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function forwardArkRequest(request, response, arkPath) {
  let body;
  try {
    body = request.method === "POST" ? await readRequestBody(request) : undefined;
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: { message: error.message } });
    return;
  }

  const headers = { Accept: request.headers.accept || "application/json" };
  if (request.headers.authorization) headers.Authorization = request.headers.authorization;
  if (request.headers["content-type"]) headers["Content-Type"] = request.headers["content-type"];
  if (body) headers["Content-Length"] = body.length;

  const upstream = https.request({
    hostname: "ark.cn-beijing.volces.com",
    port: 443,
    path: "/api/v3" + arkPath,
    method: request.method,
    headers,
    timeout: 180000
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, {
      "Content-Type": upstreamResponse.headers["content-type"] || "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    upstreamResponse.pipe(response);
  });

  upstream.on("timeout", () => upstream.destroy(new Error("方舟请求超时")));
  upstream.on("error", error => {
    if (!response.headersSent) sendJson(response, 502, { error: { message: error.message } });
    else response.destroy(error);
  });
  if (body) upstream.write(body);
  upstream.end();
}

/* ---------------- 本地素材 / 生成历史存储 ---------------- */
const MAX_STORAGE_SAVE_BYTES = 512 * 1024 * 1024;
const STORAGE_CONFIG_FILE = path.join(app.getPath("userData"), "storage.json");

function defaultStorageConfig() {
  const base = app.getPath("userData");
  const media = path.join(base, "作品素材");
  return {
    imageRoot: path.join(media, "图片"),
    videoRoot: path.join(media, "视频"),
    historyRoot: path.join(base, "生成历史"),
    canvasRoot: path.join(base, "画布")
  };
}
function readStorageConfig() {
  const fallback = defaultStorageConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORAGE_CONFIG_FILE, "utf8"));
    const legacy = parsed.mediaRoot && path.isAbsolute(parsed.mediaRoot) ? parsed.mediaRoot : "";
    const pick = (value, fallbackValue) => (value && path.isAbsolute(value) ? value : fallbackValue);
    return {
      imageRoot: pick(parsed.imageRoot, legacy || fallback.imageRoot),
      videoRoot: pick(parsed.videoRoot, legacy || fallback.videoRoot),
      historyRoot: pick(parsed.historyRoot, fallback.historyRoot),
      canvasRoot: pick(parsed.canvasRoot, fallback.canvasRoot)
    };
  } catch {
    return fallback;
  }
}
function writeStorageConfig(config) {
  fs.mkdirSync(path.dirname(STORAGE_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(STORAGE_CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}
function safeName(value, fallback) {
  const cleaned = String(value || "").replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/^\.+/, "").trim().slice(0, 90);
  return cleaned || fallback;
}
function uniqueStoragePath(directory, filename) {
  const extension = path.extname(filename);
  const base = filename.slice(0, filename.length - extension.length);
  let candidate = path.join(directory, filename);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, base + "-" + index + extension);
    index += 1;
  }
  return candidate;
}
function downloadRemoteFile(url, target) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { "User-Agent": "InfiniteCanvas-Desktop" },
      family: 4,
      timeout: 60000
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].indexOf(status) >= 0 && response.headers.location) {
        response.resume();
        downloadRemoteFile(new URL(response.headers.location, url).toString(), target).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error("下载素材失败：HTTP " + status));
        return;
      }
      const output = fs.createWriteStream(target);
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_STORAGE_SAVE_BYTES) response.destroy(new Error("素材超过 512 MB"));
      });
      response.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      response.pipe(output);
    });
    request.on("timeout", () => request.destroy(new Error("下载素材超时")));
    request.on("error", reject);
  });
}
async function handleStorageRequest(request, response, pathname) {
  const config = readStorageConfig();
  if (pathname === "/infinite-canvas/storage" && request.method === "GET") {
    sendJson(response, 200, { ...config, defaults: defaultStorageConfig() });
    return;
  }
  if (pathname === "/infinite-canvas/storage" && request.method === "POST") {
    const body = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
    const next = { imageRoot: config.imageRoot, videoRoot: config.videoRoot, historyRoot: config.historyRoot, canvasRoot: config.canvasRoot };
    if (body.imageRoot) next.imageRoot = path.resolve(String(body.imageRoot));
    if (body.videoRoot) next.videoRoot = path.resolve(String(body.videoRoot));
    if (body.historyRoot) next.historyRoot = path.resolve(String(body.historyRoot));
    if (body.canvasRoot) next.canvasRoot = path.resolve(String(body.canvasRoot));
    fs.mkdirSync(next.imageRoot, { recursive: true });
    fs.mkdirSync(next.videoRoot, { recursive: true });
    fs.mkdirSync(next.historyRoot, { recursive: true });
    fs.mkdirSync(next.canvasRoot, { recursive: true });
    writeStorageConfig(next);
    sendJson(response, 200, { ...next });
    return;
  }
  if (pathname === "/infinite-canvas/storage/pick" && request.method === "POST") {
    const body = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: body.target === "history" ? "选择生成历史保存位置"
        : body.target === "video" ? "选择视频保存位置"
        : body.target === "image" ? "选择图片保存位置"
        : body.target === "canvas" ? "选择画布保存位置"
        : "选择保存位置",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths.length) {
      sendJson(response, 200, { canceled: true });
      return;
    }
    sendJson(response, 200, { path: result.filePaths[0] });
    return;
  }
  if (pathname === "/infinite-canvas/storage/save" && request.method === "POST") {
    const body = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
    const canvas = safeName(body.canvas, "未命名画布");
    if (body.kind === "history") {
      const directory = path.join(config.historyRoot, canvas);
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "history.jsonl");
      const entry = Object.assign({ at: new Date().toISOString(), canvas: canvas }, body.entry || {});
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
      sendJson(response, 200, { ok: true, path: file });
      return;
    }
    const mediaKind = String(body.mediaKind || "") === "video" ? "video" : "image";
    const root = mediaKind === "video" ? config.videoRoot : config.imageRoot;
    const directory = path.join(root, canvas);
    fs.mkdirSync(directory, { recursive: true });
    const filename = safeName(body.filename, "media");
    const target = uniqueStoragePath(directory, filename);
    if (body.remoteUrl) {
      await downloadRemoteFile(String(body.remoteUrl), target);
    } else {
      const data = String(body.dataUrl || "");
      const comma = data.indexOf(",");
      const buffer = Buffer.from(comma >= 0 ? data.slice(comma + 1) : data, "base64");
      if (!buffer.length) throw new Error("没有可保存的素材数据");
      if (buffer.length > MAX_STORAGE_SAVE_BYTES) throw new Error("素材超过 512 MB");
      fs.writeFileSync(target, buffer);
    }
    sendJson(response, 200, { ok: true, path: target, name: path.basename(target) });
    return;
  }
  if (pathname === "/infinite-canvas/storage/history" && request.method === "GET") {
    const url = new URL(request.url, "http://127.0.0.1");
    const canvas = safeName(url.searchParams.get("canvas"), "未命名画布");
    const file = path.join(config.historyRoot, canvas, "history.jsonl");
    const entries = [];
    try {
      fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-300).forEach(line => {
        try { entries.push(JSON.parse(line)); } catch (_) {}
      });
    } catch (_) {}
    sendJson(response, 200, { canvas: canvas, entries: entries });
    return;
  }
  if (pathname === "/infinite-canvas/storage/canvas" && request.method === "GET") {
    const file = path.join(config.canvasRoot, "canvas-book.json");
    let book = null;
    try {
      book = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {}
    sendJson(response, 200, { book, path: file });
    return;
  }
  if (pathname === "/infinite-canvas/storage/canvas" && request.method === "POST") {
    const body = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
    if (!body.book || !Array.isArray(body.book.items)) throw new Error("画布数据无效");
    fs.mkdirSync(config.canvasRoot, { recursive: true });
    const file = path.join(config.canvasRoot, "canvas-book.json");
    fs.writeFileSync(file, JSON.stringify(body.book), "utf8");
    sendJson(response, 200, { ok: true, path: file });
    return;
  }
  sendJson(response, 404, { error: { message: "找不到本地存储接口" } });
}

async function handleRequest(request, response, port) {
  if (!isLoopback(request.socket.remoteAddress) || request.headers.host !== "127.0.0.1:" + port) {
    sendJson(response, 403, { error: { message: "仅允许本机桌面程序访问" } });
    return;
  }

  let pathname;
  let requestUrl;
  try {
    requestUrl = new URL(request.url, "http://127.0.0.1");
    pathname = requestUrl.pathname;
  } catch {
    sendJson(response, 400, { error: { message: "请求地址无效" } });
    return;
  }

  if (pathname === MODEL_PROXY_PATH) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: { message: "模型列表转发仅支持 GET" } });
      return;
    }
    const expectedOrigin = "http://127.0.0.1:" + port;
    if ((request.headers.origin && request.headers.origin !== expectedOrigin)
      || (request.headers.referer && !request.headers.referer.startsWith(expectedOrigin + "/"))) {
      sendJson(response, 403, { error: { message: "仅允许桌面画布读取模型列表" } });
      return;
    }
    const target = getModelCatalogTarget(requestUrl);
    if (!target) {
      sendJson(response, 400, { error: { message: "Base URL 或模型列表路径无效" } });
      return;
    }
    forwardModelListRequest(request, response, target);
    return;
  }

  if (pathname === PROVIDER_PROXY_PATH) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: { message: "音频接口转发仅支持 POST" } });
      return;
    }
    const expectedProxyOrigin = "http://127.0.0.1:" + port;
    if ((request.headers.origin && request.headers.origin !== expectedProxyOrigin)
      || (request.headers.referer && !request.headers.referer.startsWith(expectedProxyOrigin + "/"))) {
      sendJson(response, 403, { error: { message: "仅允许桌面画布访问音频接口" } });
      return;
    }
    const target = getProviderProxyTarget(requestUrl);
    if (!target) {
      sendJson(response, 400, { error: { message: "音频接口地址无效" } });
      return;
    }
    await forwardProviderRequest(request, response, target);
    return;
  }

  const expectedOrigin = "http://127.0.0.1:" + port;
  if (pathname === "/infinite-canvas/media" || pathname.startsWith("/infinite-canvas/media/")) {
    if (await handleMediaRequest(request, response, pathname, port)) return;
  }
  if (pathname.startsWith("/infinite-canvas/update/")) {
    if ((request.headers.origin && request.headers.origin !== expectedOrigin)
      || (request.headers.referer && !request.headers.referer.startsWith(expectedOrigin + "/"))) {
      sendJson(response, 403, { error: { message: "仅允许桌面画布访问更新服务" } });
      return;
    }
    if (pathname === "/infinite-canvas/update/status" && request.method === "GET") {
      sendJson(response, 200, { ...updateState, enabled: app.isPackaged });
      return;
    }
    if (pathname === "/infinite-canvas/update/check" && request.method === "POST") {
      if (!app.isPackaged) {
        sendJson(response, 200, { ...updateState, enabled: false, status: "unavailable", error: "开发模式下不能安装桌面更新" });
        return;
      }
      if (updateState.status === "checking" || updateState.status === "downloading") {
        sendJson(response, 202, { ...updateState, enabled: true });
        return;
      }
      updateState.status = "checking";
      updateState.error = "";
      updateState.availableVersion = "";
      updateState.percent = 0;
      beginUpdateCheck();
      sendJson(response, 202, { ...updateState, enabled: true });
      return;
    }
    if (pathname === "/infinite-canvas/update/install" && request.method === "POST") {
      if (!app.isPackaged || updateState.status !== "downloaded") {
        sendJson(response, 409, { error: { message: "更新包尚未下载完成" } });
        return;
      }
      sendJson(response, 202, { ...updateState, installing: true });
      setTimeout(() => {
        try {
          installDownloadedUpdate();
        } catch (error) {
          updateState.status = "error";
          updateState.error = String(error && error.message || "无法启动安装程序").slice(0, 500);
        }
      }, 250);
      return;
    }
    sendJson(response, 404, { error: { message: "找不到更新服务" } });
    return;
  }

  if (pathname === "/infinite-canvas/storage" || pathname.startsWith("/infinite-canvas/storage/")) {
    if ((request.headers.origin && request.headers.origin !== expectedOrigin)
      || (request.headers.referer && !request.headers.referer.startsWith(expectedOrigin + "/"))) {
      sendJson(response, 403, { error: { message: "仅允许桌面画布访问本地存储" } });
      return;
    }
    try {
      await handleStorageRequest(request, response, pathname);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: { message: error.message || "本地存储操作失败" } });
      else response.destroy(error);
    }
    return;
  }

  const arkPath = getArkPath(request.method, pathname);
  if (arkPath) {
    await forwardArkRequest(request, response, arkPath);
    return;
  }
  if (pathname.startsWith(API_PREFIX + "/")) {
    sendJson(response, 404, { error: { message: "未开放此方舟 API 路径" } });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: { message: "仅支持读取画布页面" } });
    return;
  }

  if (pathname === "/infinite-canvas" || pathname === "/infinite-canvas/") {
    response.writeHead(302, { Location: "/infinite-canvas/node.html", "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (pathname === "/infinite-canvas/desktop/update-ui.js") {
    try {
      const data = fs.readFileSync(path.join(APP_ROOT, "desktop", "update-ui.js"));
      response.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch {
      sendJson(response, 500, { error: { message: "无法读取更新界面" } });
    }
    return;
  }

  const fileName = pathname === "/infinite-canvas/index.html" ? "index.html"
    : pathname === "/infinite-canvas/node.html" ? "node.html" : null;
  if (!fileName) {
    sendJson(response, 404, { error: { message: "找不到此页面" } });
    return;
  }

  try {
    const data = fs.readFileSync(path.join(APP_ROOT, fileName));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch {
    sendJson(response, 500, { error: { message: "无法读取画布页面" } });
  }
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      handleRequest(request, response, port).catch(error => {
        if (!response.headersSent) sendJson(response, 500, { error: { message: error.message } });
        else response.destroy(error);
      });
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function startLocalServer() {
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  const portFile = path.join(userData, "desktop-server-port.json");
  let savedPort;
  try {
    savedPort = JSON.parse(fs.readFileSync(portFile, "utf8")).port;
  } catch {}

  const candidates = [...new Set([savedPort, ...Array.from({ length: 20 }, (_, i) => DEFAULT_PORT + i)])]
    .filter(port => Number.isInteger(port) && port > 0 && port < 65536);
  let lastError;
  for (const port of candidates) {
    try {
      localServer = await listen(port);
      fs.writeFileSync(portFile, JSON.stringify({ port }), "utf8");
      return port;
    } catch (error) {
      lastError = error;
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw lastError || new Error("没有可用的本机端口");
}

function createWindow(port) {
  const origin = "http://127.0.0.1:" + port;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: PRODUCT_NAME,
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#080d12",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin + "/")) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadURL(origin + "/infinite-canvas/node.html");
}

app.on("before-quit", () => {
  if (localServer) localServer.close();
});

app.on("window-all-closed", () => app.quit());
