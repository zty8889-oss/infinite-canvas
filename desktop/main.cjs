const { app, BrowserWindow, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const PRODUCT_NAME = "无限画布";
const DEFAULT_PORT = 43621;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const API_PREFIX = "/infinite-canvas/ark-proxy";
const MODEL_PROXY_PATH = "/infinite-canvas/model-proxy";
const APP_ROOT = app.getAppPath();
let localServer;
let mainWindow;
const updateState = {
  status: "idle",
  currentVersion: app.getVersion(),
  availableVersion: "",
  percent: 0,
  error: ""
};

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.on("checking-for-update", () => { updateState.status = "checking"; updateState.error = ""; });
autoUpdater.on("update-available", info => {
  updateState.status = "downloading";
  updateState.availableVersion = info.version || "";
  updateState.percent = 0;
});
autoUpdater.on("update-not-available", () => {
  updateState.status = "current";
  updateState.availableVersion = "";
  updateState.percent = 0;
});
autoUpdater.on("download-progress", progress => {
  updateState.status = "downloading";
  updateState.percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
});
autoUpdater.on("update-downloaded", info => {
  updateState.status = "downloaded";
  updateState.availableVersion = info.version || updateState.availableVersion;
  updateState.percent = 100;
});
autoUpdater.on("error", error => {
  updateState.status = "error";
  updateState.error = String(error && error.message || "更新检查失败").slice(0, 500);
});

app.setName(PRODUCT_NAME);
app.setPath("userData", path.join(app.getPath("appData"), "InfiniteCanvasDesktop"));

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
  if (!headers.Authorization) {
    sendJson(response, 401, { error: { message: "缺少 API Key" } });
    return;
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

  const expectedOrigin = "http://127.0.0.1:" + port;
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
      autoUpdater.checkForUpdates().catch(error => {
        updateState.status = "error";
        updateState.error = String(error && error.message || "更新检查失败").slice(0, 500);
      });
      sendJson(response, 202, { ...updateState, enabled: true });
      return;
    }
    if (pathname === "/infinite-canvas/update/install" && request.method === "POST") {
      if (!app.isPackaged || updateState.status !== "downloaded") {
        sendJson(response, 409, { error: { message: "更新包尚未下载完成" } });
        return;
      }
      sendJson(response, 202, { ...updateState, installing: true });
      setTimeout(() => autoUpdater.quitAndInstall(false, true), 250);
      return;
    }
    sendJson(response, 404, { error: { message: "找不到更新服务" } });
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
