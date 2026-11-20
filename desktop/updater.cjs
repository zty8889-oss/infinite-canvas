// Custom update client for the desktop app.
// Uses the GitHub REST API (api.github.com + asset CDN) instead of the
// github.com/releases/download redirector, which is often blocked. Downloads run
// over several ranged connections because a single connection is heavily throttled
// on some networks.
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const OWNER = "zty8889-oss";
const REPO = "infinite-canvas";
const USER_AGENT = "InfiniteCanvas-Updater";
const API = "https://api.github.com/repos/" + OWNER + "/" + REPO;
const PARALLEL_THRESHOLD = 6 * 1024 * 1024;
const CONNECTIONS = 8;

function requestStream(url, headers, timeout, redirects) {
  const remaining = redirects === undefined ? 4 : redirects;
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: Object.assign({ "User-Agent": USER_AGENT }, headers || {}),
      family: 4,
      timeout: timeout || 30000
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].indexOf(status) >= 0 && response.headers.location && remaining > 0) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        requestStream(next, headers, timeout, remaining - 1).then(resolve, reject);
        return;
      }
      resolve({ response, request, status });
    });
    request.on("timeout", () => request.destroy(new Error("连接更新服务器超时")));
    request.on("error", reject);
  });
}

async function readText(url, options) {
  const opts = options || {};
  const limit = opts.limit || 2 * 1024 * 1024;
  const { response } = await requestStream(url, opts.headers);
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error("HTTP " + response.statusCode);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) throw new Error("更新清单过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseManifest(text) {
  return {
    version: (text.match(/^version:\s*(\S+)/m) || [])[1] || "",
    sha512: (text.match(/sha512:\s*(\S+)/) || [])[1] || "",
    size: Number((text.match(/size:\s*(\d+)/) || [])[1] || 0)
  };
}

async function fetchLatest() {
  const release = JSON.parse(await readText(API + "/releases/latest", {
    headers: { Accept: "application/vnd.github+json" }
  }));
  const assets = release.assets || [];
  const manifestAsset = assets.find(asset => asset.name === "latest.yml");
  const packageAsset = assets.find(asset => /Setup\.exe$/i.test(asset.name));
  if (!manifestAsset || !packageAsset) throw new Error("该版本缺少安装包或更新清单");

  const manifest = await readText(API + "/releases/assets/" + manifestAsset.id, {
    headers: { Accept: "application/octet-stream" }
  });
  const parsed = parseManifest(manifest);
  return {
    version: (parsed.version || String(release.tag_name || "").replace(/^v/i, "")).trim(),
    sha512: parsed.sha512,
    asset: {
      id: packageAsset.id,
      name: packageAsset.name,
      size: parsed.size || packageAsset.size || 0
    }
  };
}

function isNewer(candidate, current) {
  const parse = value => String(value || "").split(/[.-]/).map(part => parseInt(part, 10) || 0);
  const left = parse(candidate);
  const right = parse(current);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

async function probeTotal(url, fallback) {
  try {
    const { response } = await requestStream(url, {
      Accept: "application/octet-stream",
      Range: "bytes=0-0"
    }, 20000);
    if (response.statusCode !== 206) {
      response.resume();
      return 0;
    }
    const range = response.headers["content-range"] || "";
    const total = Number(range.split("/")[1] || 0);
    response.resume();
    return total || Number(fallback) || 0;
  } catch {
    return 0;
  }
}

function fetchPart(url, start, end, file, state) {
  return new Promise((resolve, reject) => {
    requestStream(url, {
      Accept: "application/octet-stream",
      Range: "bytes=" + start + "-" + end
    }, 30000).then(({ response, request, status }) => {
      if (status !== 206) {
        response.resume();
        reject(new Error("RANGE_UNSUPPORTED"));
        return;
      }
      state.requests.push(request);
      const output = fs.createWriteStream(file);
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        output.destroy();
        reject(error);
      };
      request.on("error", fail);
      response.on("aborted", () => fail(new Error("SLOW_NETWORK")));
      response.on("data", chunk => { state.received += chunk.length; });
      response.on("error", fail);
      output.on("error", fail);
      output.on("finish", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      response.pipe(output);
    }, reject);
  });
}

async function verify(destination, sha512) {
  if (!sha512) return;
  const hash = crypto.createHash("sha512");
  await new Promise((resolve, reject) => {
    fs.createReadStream(destination)
      .on("data", chunk => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  if (hash.digest("base64") !== sha512) {
    fs.rmSync(destination, { force: true });
    throw new Error("安装包校验失败，请重新下载");
  }
}

async function downloadParallel(url, total, destination, onProgress, options) {
  const opts = options || {};
  const minSpeed = opts.minSpeedBytesPerSecond || 60 * 1024;
  const graceMs = opts.graceMs || 30000;
  const chunk = Math.ceil(total / CONNECTIONS);
  const parts = [];
  const state = { received: 0, requests: [], startedAt: Date.now(), aborted: false };

  const timer = setInterval(() => {
    const elapsed = Date.now() - state.startedAt;
    const speed = state.received / Math.max(1, elapsed / 1000);
    if (onProgress) onProgress(Math.min(99, Math.round((state.received / total) * 100)), state.received, Math.round(speed));
    if (elapsed > graceMs && speed < minSpeed && !state.aborted) {
      state.aborted = true;
      state.requests.forEach(request => request.destroy(new Error("SLOW_NETWORK")));
    }
  }, 400);

  try {
    const tasks = [];
    for (let index = 0; index < CONNECTIONS; index += 1) {
      const start = index * chunk;
      const end = Math.min(total - 1, start + chunk - 1);
      if (start > end) break;
      const file = destination + ".part" + index;
      parts.push(file);
      tasks.push(fetchPart(url, start, end, file, state));
    }
    await Promise.all(tasks);

    const combined = destination + ".part";
    fs.rmSync(combined, { force: true });
    for (const file of parts) {
      fs.appendFileSync(combined, fs.readFileSync(file));
    }
    await verify(combined, opts.sha512);
    fs.renameSync(combined, destination);
    return destination;
  } finally {
    clearInterval(timer);
    parts.forEach(file => fs.rmSync(file, { force: true }));
    fs.rmSync(destination + ".part", { force: true });
  }
}

async function downloadSingle(url, latest, destination, onProgress, options) {
  const opts = options || {};
  const minSpeed = opts.minSpeedBytesPerSecond || 60 * 1024;
  const graceMs = opts.graceMs || 30000;
  const { response } = await requestStream(url, { Accept: "application/octet-stream" }, 30000);
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error("HTTP " + response.statusCode);
  }
  const total = Number(response.headers["content-length"] || latest.asset.size || 0);
  const partial = destination + ".part";
  const startedAt = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(partial);
      let received = 0;
      let lastTick = 0;
      response.on("data", chunk => {
        received += chunk.length;
        const elapsed = Date.now() - startedAt;
        const speed = elapsed > 0 ? received / (elapsed / 1000) : 0;
        if (elapsed > graceMs && speed < minSpeed) {
          response.destroy(new Error("SLOW_NETWORK"));
          return;
        }
        const now = Date.now();
        if (now - lastTick > 200) {
          lastTick = now;
          if (onProgress) onProgress(total ? Math.min(99, Math.round((received / total) * 100)) : 0, received, Math.round(speed));
        }
      });
      response.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      response.pipe(output);
    });
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  await verify(partial, latest.sha512);
  fs.renameSync(partial, destination);
  return destination;
}

async function download(latest, destination, onProgress, options) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const url = API + "/releases/assets/" + latest.asset.id;
  const total = Number(latest.asset.size) || 0;
  if (total > PARALLEL_THRESHOLD) {
    const probed = await probeTotal(url, total);
    if (probed && Math.abs(probed - total) < 1024) {
      try {
        return await downloadParallel(url, total, destination, onProgress, Object.assign({}, options, { sha512: latest.sha512 }));
      } catch (error) {
        if (error.message !== "RANGE_UNSUPPORTED") throw error;
      }
    }
  }
  return downloadSingle(url, latest, destination, onProgress, options);
}

module.exports = { fetchLatest, download, isNewer };
