"use strict";

const $ = selector => document.querySelector(selector);
const elements = {
  badge: $("#connectionBadge"),
  localSdp: $("#localSdp"),
  remoteSdp: $("#remoteSdp"),
  roleHint: $("#roleHint"),
  createOffer: $("#createOffer"),
  createAnswer: $("#createAnswer"),
  acceptOffer: $("#acceptOffer"),
  applyAnswer: $("#applyAnswer"),
  iceRestart: $("#iceRestart"),
  newChannel: $("#newChannel"),
  iceState: $("#iceState"),
  peerState: $("#peerState"),
  gatheringState: $("#gatheringState"),
  channelState: $("#channelState"),
  candidateSummary: $("#candidateSummary"),
  iceHint: $("#iceHint"),
  senderList: $("#senderList"),
  receiverList: $("#receiverList"),
  sendSummary: $("#sendSummary"),
  receiveSummary: $("#receiveSummary"),
  log: $("#log")
};

const connection = new ConnectionManager();
const sender = new SenderManager(connection);
const receiver = new ReceiverManager(connection);
const rateSamples = new Map();
let selectedRole = null;

const statusText = {
  queued: "排队中",
  sending: "发送中",
  receiving: "接收中",
  waiting: "等待连接恢复",
  verifying: "最终校验中",
  done: "完成",
  error: "错误",
  needs_file: "请重新选择本地文件",
  needs_directory: "请选择目录"
};

function calculateRate(scope, file) {
  const key = `${scope}:${file.id}`;
  const current = { offset: file.durable, time: performance.now() };
  const previous = rateSamples.get(key);
  let speed = 0;
  if (previous) {
    const elapsed = (current.time - previous.time) / 1000;
    const delta = file.durable - previous.offset;
    if (elapsed > 0 && delta >= 0) speed = delta / elapsed;
  }
  rateSamples.set(key, current);
  return speed;
}

function backpressureText(scope, file) {
  if (scope === "send") {
    const buffered = connection.bufferedAmount;
    const queued = file.inFlightBytes || 0;
    if (buffered >= 1024 * 1024) return "发送缓冲背压：暂停";
    return `未确认窗口 ${appUtils.bytes(queued)} / 8 MiB · SCTP 缓冲 ${appUtils.bytes(buffered)}`;
  }
  return file.savedName ? `已保存：${file.savedName}` : `临时文件：${file.partName || "尚未创建"}`;
}

function renderFile(scope, file) {
  const row = document.createElement("div");
  row.className = "file-row";
  const speed = calculateRate(scope, file);
  const action = scope === "send" ? "已发送" : "已落盘";
  const hash = file.fullHash ? appUtils.shortHash(file.fullHash) : "完成后显示";
  const status = statusText[file.status] || file.status;
  const isCurrent = sender.current && sender.current.id === file.id;
  const actionButton = scope === "send"
    ? (!file.file ? `<button type="button" data-action="pick" data-id="${file.id}">重新选择</button>` : "")
    : "";
  row.innerHTML = `
    <div class="file-title">
      <div class="file-name" title="${appUtils.escapeHtml(file.name)}">${appUtils.escapeHtml(file.name)}</div>
      <span class="status ${file.status}">${status}</span>
    </div>
    <div class="progress"><div style="width:${Math.min(100, Math.max(0, file.progress || 0)).toFixed(2)}%"></div></div>
    <div class="file-meta">
      <span>${action} ${appUtils.bytes(file.durable)} / ${appUtils.bytes(file.size)}</span>
      <span>速度 ${appUtils.rate(speed)}</span>
      <span>${appUtils.bytes(file.size)} · ${(file.progress || 0).toFixed(1)}%</span>
      <span class="hash-line">SHA-256 ${hash}</span>
      <span class="wide">${backpressureText(scope, file)}</span>
    </div>
    ${file.error ? `<p class="hint bad">${appUtils.escapeHtml(file.error)}</p>` : ""}
    <div class="button-row">
      ${scope === "send" && file.status !== "done" && file.file
        ? `<button type="button" class="secondary" data-action="retry" data-id="${file.id}">重新续传</button>` : ""}
      ${scope === "send" && file.status !== "done" && !isCurrent
        ? `<button type="button" class="danger" data-action="remove" data-id="${file.id}">移除</button>` : ""}
      ${file.status === "done" ? `<button type="button" class="secondary" data-action="clear" data-id="${file.id}">清除</button>` : ""}
      ${actionButton}
    </div>
  `;
  return row;
}

function renderLists() {
  const sent = sender.stats();
  const received = receiver.stats();
  elements.senderList.classList.toggle("empty", sent.length === 0);
  elements.receiverList.classList.toggle("empty", received.length === 0);
  elements.senderList.textContent = sent.length ? "" : "尚未选择文件";
  elements.receiverList.textContent = received.length ? "" : "等待发送";

  for (const file of sent) elements.senderList.appendChild(renderFile("send", file));
  for (const file of received) elements.receiverList.appendChild(renderFile("receive", file));

  const activeSend = sent.find(file => file.status === "sending" || file.status === "waiting");
  elements.sendSummary.textContent = activeSend
    ? `当前：${activeSend.name} · ${activeSend.status === "waiting" ? "等待重连" : "传输中"}`
    : `发送队列 ${sent.length} 个文件，多文件按顺序传输。`;

  const activeReceive = received.find(file => file.status === "receiving" || file.status === "waiting");
  elements.receiveSummary.textContent = receiver.directoryName
    ? `接收目录：${receiver.directoryName}${activeReceive ? ` · 当前：${activeReceive.name}` : ""}`
    : "接收端必须先选择可写目录。";
}

function bindQueueActions() {
  elements.senderList.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.action === "remove") sender.removeFile(id);
    if (button.dataset.action === "retry") sender.retry(id);
    if (button.dataset.action === "clear") {
      sender.files = sender.files.filter(file => file.id !== id);
      sender.persist(true);
      sender.emitChange();
    }
    if (button.dataset.action === "pick") {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = false;
      input.addEventListener("change", async () => {
        const file = input.files[0];
        if (!file) return;
        const match = sender.files.find(item => item.id === id);
        if (match && file.name === match.name && file.size === match.size) {
          await sender.addFiles(input.files);
        } else {
          log("重新选择的文件名或大小与原文件不一致。", "error");
        }
      });
      input.click();
    }
  });
  elements.receiverList.addEventListener("click", event => {
    const button = event.target.closest("button[data-action='clear']");
    if (!button) return;
    receiver.files.delete(button.dataset.id);
    receiver.order = receiver.order.filter(id => id !== button.dataset.id);
    receiver.persist(true);
    receiver.emitChange();
  });
}

function log(message, level = "info") {
  const line = document.createElement("div");
  line.className = `log-entry ${level}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  elements.log.appendChild(line);
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setRole(role) {
  selectedRole = role;
  connection.setRole(role);
  elements.localSdp.value = "";
  document.querySelectorAll("[data-role]").forEach(button => {
    button.classList.toggle("active", button.dataset.role === role);
  });
  const offerer = role === "offerer";
  elements.createOffer.hidden = !offerer;
  elements.applyAnswer.hidden = !offerer;
  elements.createAnswer.hidden = offerer;
  elements.acceptOffer.hidden = offerer;
  elements.roleHint.textContent = offerer
    ? "设备 A：创建 Offer，复制给设备 B；再粘贴设备 B 的 Answer。"
    : "设备 B：先粘贴设备 A 的 Offer，生成 Answer；再复制回设备 A。";
  log(`已选择${offerer ? "发起方" : "应答方"}角色`, "good");
}

async function createOffer(restart = false, fresh = false) {
  try {
    const description = await connection.createOffer({ restart, fresh });
    elements.localSdp.value = description.sdp;
    log(restart ? "已生成 ICE 重启 Offer，请重新走一遍 SDP 交换。" : "已生成 Offer。");
  } catch (error) {
    log(error.message || String(error), "error");
  }
}

async function acceptOffer() {
  try {
    const sdp = elements.remoteSdp.value.trim();
    if (!sdp) throw new Error("请先粘贴对方 Offer");
    const answer = await connection.acceptOffer(sdp);
    elements.localSdp.value = answer.sdp;
    log("已生成 Answer，请复制回发起方。");
  } catch (error) {
    log(error.message || String(error), "error");
  }
}

async function applyAnswer() {
  try {
    const sdp = elements.remoteSdp.value.trim();
    if (!sdp) throw new Error("请先粘贴对方 Answer");
    await connection.applyAnswer(sdp);
    log("已应用 Answer。");
  } catch (error) {
    log(error.message || String(error), "error");
  }
}

function iceMessage(state) {
  if (state.connectionState === "connected" || state.connectionState === "completed") {
    return { text: "连接正常。", level: "good" };
  }
  if (state.iceConnectionState === "connected" || state.iceConnectionState === "completed") {
    return { text: "ICE 已连通。", level: "good" };
  }
  if (state.iceConnectionState === "failed") {
    return {
      text: "ICE 连接失败：两侧网络无法直连。可先点 ICE 重启；若仍失败，请配置可用 TURN（建议 TURNS/TCP）后建立全新连接。",
      level: "bad"
    };
  }
  if (state.connectionState === "disconnected") {
    return { text: "连接暂时中断：等待网络恢复；也可以进行 ICE 重启。发送队列会停在已确认偏移。", level: "bad" };
  }
  if (state.connectionState === "failed") {
    return { text: "PeerConnection 已失败，请 ICE 重启或建立全新连接。文件进度不会丢失。", level: "bad" };
  }
  if (state.iceConnectionState === "checking" || state.connectionState === "connecting") {
    return { text: "正在检查 ICE 候选。若长时间停留，通常是 NAT/防火墙阻挡或缺少 TURN。", level: "" };
  }
  return { text: "同一局域网通常使用 host；没有公共 IP 候选时请配置 TURN。", level: "" };
}

function updateStatus(state) {
  if (connection.pc && connection.pc.localDescription) {
    elements.localSdp.value = connection.pc.localDescription.sdp;
  }
  elements.iceState.textContent = state.iceConnectionState;
  elements.peerState.textContent = state.connectionState;
  elements.gatheringState.textContent = state.iceGatheringState;
  elements.channelState.textContent = state.channelState;
  const counts = state.candidateTypes;
  elements.candidateSummary.textContent =
    `host ${counts.host} / srflx ${counts.srflx} / relay ${counts.relay}`;

  const online = state.channelState === "open";
  const busy = ["connecting", "checking", "new"].includes(state.connectionState) ||
    ["checking", "new"].includes(state.iceConnectionState);
  const failed = ["failed", "disconnected"].includes(state.connectionState) ||
    ["failed", "disconnected"].includes(state.iceConnectionState);
  elements.badge.className = `badge ${online ? "online" : failed ? "error" : busy ? "connecting" : "offline"}`;
  elements.badge.textContent = online
    ? "DataChannel 已连接"
    : state.connectionState === "failed"
      ? "连接失败"
      : state.connectionState === "disconnected"
        ? "连接中断"
        : state.iceConnectionState === "checking"
          ? "ICE 检查中"
          : "未连接";

  const hint = iceMessage(state);
  elements.iceHint.textContent = hint.text;
  elements.iceHint.className = `hint ${hint.level}`;
}

function loadNetworkSettings() {
  const settings = appUtils.loadJson(appUtils.SETTINGS_KEY, {
    stunUrls: "stun:stun.l.google.com:19302",
    turnUrls: "",
    turnUsername: "",
    turnCredential: ""
  });
  $("#stunUrls").value = settings.stunUrls || "";
  $("#turnUrls").value = settings.turnUrls || "";
  $("#turnUsername").value = settings.turnUsername || "";
  $("#turnPassword").value = settings.turnCredential || "";
}

function bindSignaling() {
  document.querySelectorAll("[data-role]").forEach(button => {
    button.addEventListener("click", () => setRole(button.dataset.role));
  });
  elements.createOffer.addEventListener("click", () => createOffer(false, false));
  elements.iceRestart.addEventListener("click", () => createOffer(true, false));
  elements.newChannel.addEventListener("click", () => createOffer(false, true));
  elements.acceptOffer.addEventListener("click", acceptOffer);
  elements.applyAnswer.addEventListener("click", applyAnswer);
  $("#copyLocal").addEventListener("click", async () => {
    if (!elements.localSdp.value) return log("还没有可复制的 SDP。", "warn");
    await appUtils.copyText(elements.localSdp.value);
    log("已复制本端 SDP。", "good");
  });
  $("#downloadSdp").addEventListener("click", () => {
    appUtils.downloadText(`${selectedRole || "sdp"}.txt`, elements.localSdp.value);
  });
  $("#pasteRemote").addEventListener("click", async () => {
    try {
      elements.remoteSdp.value = await navigator.clipboard.readText();
    } catch (error) {
      log("无法自动读取剪贴板，请手动粘贴。", "warn");
    }
  });
  $("#clearSdp").addEventListener("click", () => {
    elements.remoteSdp.value = "";
  });
  $("#saveNetwork").addEventListener("click", () => {
    appUtils.saveJson(appUtils.SETTINGS_KEY, {
      stunUrls: $("#stunUrls").value,
      turnUrls: $("#turnUrls").value,
      turnUsername: $("#turnUsername").value,
      turnCredential: $("#turnPassword").value
    });
    log("ICE 服务器配置已保存；新连接生效。", "good");
  });
  $("#fileInput").addEventListener("change", async event => {
    await sender.addFiles(event.target.files);
    event.target.value = "";
  });
  $("#chooseDirectory").addEventListener("click", async () => {
    try {
      await receiver.chooseDirectory();
      log("接收目录已选择并授权。", "good");
    } catch (error) {
      log(error.message || String(error), "error");
    }
  });
  $("#clearSent").addEventListener("click", () => sender.clearFinished());
  $("#clearLog").addEventListener("click", () => { elements.log.textContent = ""; });
}

connection.addEventListener("status", event => updateStatus(event.detail));
connection.addEventListener("icewarning", event => log(event.detail.error, "warn"));
sender.addEventListener("log", event => log(event.detail.message));
receiver.addEventListener("log", event => log(event.detail.message));

loadNetworkSettings();
bindSignaling();
bindQueueActions();
sender.addEventListener("change", renderLists);
receiver.addEventListener("change", renderLists);
receiver.restoreDirectoryHandle().then(available => {
  if (available) log("已恢复接收目录授权。", "good");
});
updateStatus(connection.state());
renderLists();
setInterval(renderLists, 500);
