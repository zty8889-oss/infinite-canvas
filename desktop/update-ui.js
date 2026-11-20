(function(){
  "use strict";
  if (!/Electron\//.test(navigator.userAgent) || location.hostname !== "127.0.0.1") return;

  var toolbar = document.getElementById("updateAnchor") || document.getElementById("barLeft") || document.getElementById("toolbar");
  if (!toolbar) return;

  var style = document.createElement("style");
  style.textContent = [
    ".update-modal{position:fixed;inset:0;z-index:110;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(4,7,11,.72);backdrop-filter:blur(8px)}",
    ".update-modal.on{display:flex}",
    ".update-box{width:min(430px,94vw);padding:22px;background:#17191e;border:1px solid #383b43;border-radius:14px;color:#e8eaf0;box-shadow:0 24px 80px rgba(0,0,0,.55)}",
    ".update-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}",
    ".update-mark{width:38px;height:38px;display:grid;place-items:center;border:1px solid #246579;border-radius:10px;background:rgba(43,197,235,.08);color:#62dafa;box-shadow:0 0 22px rgba(43,197,235,.12)}",
    ".update-head strong{display:block;font-size:15px}.update-head small{display:block;margin-top:3px;color:#858a95;font-size:11px}",
    ".update-close{margin-left:auto;width:30px;height:30px;border:1px solid #373a42;border-radius:8px;background:#22242a;color:#aeb2bc;font-size:18px;cursor:pointer}",
    ".update-state{min-height:44px;color:#c6c9d1;font-size:13px;line-height:1.6;white-space:pre-wrap}",
    ".update-progress{height:5px;margin:12px 0 4px;overflow:hidden;border-radius:5px;background:#2b2e35}",
    ".update-progress i{display:block;width:0;height:100%;border-radius:inherit;background:#45d4fa;transition:width .2s}",
    ".update-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}",
    ".update-actions button{min-height:34px;padding:0 13px;border:1px solid #3a3d45;border-radius:8px;background:#23252b;color:#c8cbd3;font-size:12px;cursor:pointer}",
    ".update-actions button.primary{border-color:#2c9cb8;background:#147d98;color:#fff;font-weight:650}",
    ".update-actions button:disabled{opacity:.45;cursor:default}",
    ".update-actions .update-manual{margin-right:auto}",
    "#software-update-button{display:inline-flex;align-items:center;gap:6px}",
    "#software-update-button svg{width:15px;height:15px;flex:0 0 auto}",
    "#software-update-button.ready{border-color:#2299b5;color:#26b8db}",
    "@media(max-width:600px){.update-box{padding:18px}.update-state{font-size:12px}}"
  ].join("");
  document.head.appendChild(style);

  var divider = document.createElement("span");
  divider.className = "sep";
  var trigger = document.createElement("button");
  trigger.id = "software-update-button";
  trigger.type = "button";
  trigger.title = "检查并安装软件更新";
  trigger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 16v4h14v-4"/></svg><span>软件更新</span>';
  toolbar.appendChild(divider);
  toolbar.appendChild(trigger);

  var modal = document.createElement("div");
  modal.className = "update-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "软件更新");
  modal.innerHTML = '<section class="update-box"><header class="update-head"><span class="update-mark"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 16v4h14v-4"/></svg></span><div><strong>软件更新</strong><small class="update-version">当前版本</small></div><button class="update-close" type="button" aria-label="关闭">×</button></header><div class="update-state">正在读取版本信息…</div><div class="update-progress"><i></i></div><footer class="update-actions"><button class="update-manual" type="button">打开发布页</button><button class="update-check" type="button">检查更新</button><button class="update-install primary" type="button" hidden>重启并安装</button></footer></section>';
  document.body.appendChild(modal);

  var stateEl = modal.querySelector(".update-state");
  var versionEl = modal.querySelector(".update-version");
  var progress = modal.querySelector(".update-progress");
  var progressBar = progress.querySelector("i");
  var checkButton = modal.querySelector(".update-check");
  var installButton = modal.querySelector(".update-install");
  var manualButton = modal.querySelector(".update-manual");
  var latestState = {};
  var pollTimer = 0;

  function paint(state){
    latestState = state || {};
    versionEl.textContent = "当前版本 " + (state.currentVersion || "未知");
    installButton.hidden = state.status !== "downloaded";
    checkButton.hidden = state.status === "downloaded";
    checkButton.disabled = state.status === "checking" || state.status === "downloading";
    trigger.classList.toggle("ready", state.status === "downloaded");
    progress.hidden = state.status !== "downloading" && state.status !== "downloaded";
    progressBar.style.width = (state.status === "downloaded" ? 100 : state.percent || 0) + "%";
    if (!state.enabled) stateEl.textContent = state.error || "更新功能仅在已安装的桌面版中可用。";
    else if (state.status === "checking") stateEl.textContent = "正在检查新版本…";
    else if (state.status === "downloading") stateEl.textContent = "正在下载 " + (state.availableVersion ? "v" + state.availableVersion + " " : "") + (state.percent || 0) + "%" + (state.speed ? " · " + Math.round(state.speed / 1024) + " KB/s" : "");
    else if (state.status === "downloaded") stateEl.textContent = "新版本 " + (state.availableVersion ? "v" + state.availableVersion + " " : "") + "已下载，重启后自动安装。";
    else if (state.status === "current") stateEl.textContent = "当前已是最新版本。";
    else if (state.status === "error") stateEl.textContent = "更新失败：" + (state.error || "请检查网络后重试。");
    else if (state.status === "unavailable") stateEl.textContent = state.error || "当前版本暂不支持软件内更新。";
    else stateEl.textContent = "点击检查更新，软件会自动下载可用版本。";
  }

  async function request(path, method){
    var response = await fetch("/infinite-canvas/update/" + path, {method:method || "GET", headers:method ? {"Content-Type":"application/json"} : undefined});
    var data = await response.json();
    if (!response.ok) throw new Error(data.error && data.error.message || "更新服务暂时不可用");
    return data;
  }

  async function refresh(){
    try{
      var state = await request("status");
      paint(state);
      if (state.status === "checking" || state.status === "downloading") pollTimer = window.setTimeout(refresh, 900);
    }catch(error){
      paint({enabled:false,error:error.message,status:"unavailable"});
    }
  }

  trigger.addEventListener("click",function(){
    modal.classList.add("on");
    refresh();
    request("check","POST").then(function(state){paint(state);pollTimer=window.setTimeout(refresh,900);})
      .catch(function(error){paint({enabled:true,status:"error",error:error.message});});
  });
  checkButton.addEventListener("click",function(){
    checkButton.disabled=true;
    request("check","POST").then(function(state){paint(state);pollTimer=window.setTimeout(refresh,900);})
      .catch(function(error){paint({enabled:true,status:"error",error:error.message});});
  });
  installButton.addEventListener("click",function(){
    installButton.disabled=true;
    installButton.textContent="正在重启…";
    request("install","POST").catch(function(error){installButton.disabled=false;installButton.textContent="重启并安装";paint({enabled:true,status:"error",error:error.message});});
  });
  manualButton.addEventListener("click",function(){
    var url = latestState.manualUrl || "https://github.com/zty8889-oss/infinite-canvas/releases/latest";
    window.open(url, "_blank", "noopener");
  });
  modal.querySelector(".update-close").addEventListener("click",function(){modal.classList.remove("on");});
  modal.addEventListener("click",function(event){if(event.target===modal)modal.classList.remove("on");});
})();
