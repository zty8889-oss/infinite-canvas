// Custom update client for the desktop app.
// Uses the GitHub REST API instead of github.com/releases/download/*, because the
// release redirector host is frequently unreachable from mainland networks while
// api.github.com and the asset CDN stay reachable.
const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");

const OWNER = "zty8889-oss";
const REPO = "infinite-canvas";
const USER_AGENT = "InfiniteCanvas-Updater";
const API = "https://api.github.com/repos/" + OWNER + "/" + REPO;

function openStream(url, options) {
  const opts = options || {};
  const headers = Object.assign({ "User-Agent": USER_AGENT }, opts.headers || {});
  const redirects = opts.redirects === undefined ? 4 : opts.redirects;
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, family: 4, timeout: opts.timeout || 25000 }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].indexOf(status) >= 0 && response.headers.location && redirects > 0) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        resolve(openStream(next, { headers: opts.headers, redirects: redirects - 1, timeout: opts.timeout }));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error("HTTP " + status));
        return;
      }
      resolve(response);
    });
    request.on("timeout", () => request.destroy(new Error("连接更新服务器超时")));
    request.on("error", reject);
  });
}

async function readText(url, options) {
  const limit = (options && options.limit) || 2 * 1024 * 1024;
  const response = await openStream(url, options);
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
  const version = (text.match(/^version:\s*(\S+)/m) || [])[1] || "";
  const sha512 = (text.match(/sha512:\s*(\S+)/) || [])[1] || "";
  const size = Number((text.match(/size:\s*(\d+)/) || [])[1] || 0);
  return { version, sha512, size };
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

async function download(latest, destination, onProgress, options) {
  fs.mkdirSync(require("node:path").dirname(destination), { recursive: true });
  const opts = options || {};
  const minSpeed = opts.minSpeedBytesPerSecond || 90 * 1024;
  const graceMs = opts.graceMs || 25000;
  const response = await openStream(API + "/releases/assets/" + latest.asset.id, {
    headers: { Accept: "application/octet-stream" },
    timeout: 30000
  });
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

  if (latest.sha512) {
    const hash = crypto.createHash("sha512");
    await new Promise((resolve, reject) => {
      fs.createReadStream(partial)
        .on("data", chunk => hash.update(chunk))
        .on("end", resolve)
        .on("error", reject);
    });
    if (hash.digest("base64") !== latest.sha512) {
      fs.rmSync(partial, { force: true });
      throw new Error("安装包校验失败，请重新下载");
    }
  }
  fs.renameSync(partial, destination);
  return destination;
}

module.exports = { fetchLatest, download, isNewer };
