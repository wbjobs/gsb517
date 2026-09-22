import { SignalingManager, normalizeSdp } from "./signaling.js";
import { TransferManager } from "./transfer.js";
import { createReceiverEntry, createSenderEntry, fileIdFor, receiverStates, scanReceivedFiles, storageSummary } from "./state.js";
import { formatBytes, formatSpeed } from "./utils.js";

const $ = (id) => document.getElementById(id);
const elements = {
  hostTab: $("hostRoleTab"),
  guestTab: $("guestRoleTab"),
  iceServers: $("iceServers"),
  relayMode: $("relayMode"),
  createOffer: $("createOfferBtn"),
  createAnswer: $("createAnswerBtn"),
  acceptAnswer: $("acceptAnswerBtn"),
  restartIce: $("restartIceBtn"),
  relayFallback: $("relayFallbackBtn"),
  newConnection: $("newConnectionBtn"),
  localSdp: $("localSdp"),
  remoteSdp: $("remoteSdp"),
  copyLocal: $("copyLocalSdpBtn"),
  pasteRemote: $("pasteRemoteSdpBtn"),
  status: $("signalingStatus"),
  pill: $("connectionPill"),
  dropZone: $("dropZone"),
  fileInput: $("fileInput"),
  chunkSize: $("chunkSizeSelect"),
  sendQueue: $("sendQueueBtn"),
  pauseQueue: $("pauseQueueBtn"),
  clearDone: $("clearDoneBtn"),
  storageInfo: $("storageInfo"),
  queue: $("fileQueue"),
  rowTemplate: $("fileRowTemplate"),
};

let role = "host";
let connected = false;
const entries = [];

const signaling = new SignalingManager({
  getConfig: () => {
    let iceServers;
    try {
      iceServers = JSON.parse(elements.iceServers.value || "[]");
      if (!Array.isArray(iceServers)) throw new Error("ICE Servers 必须是 JSON 数组");
    } catch (error) {
      throw new Error(`ICE Servers 配置无效：${error.message}`);
    }
    return {
      iceServers,
      iceTransportPolicy: elements.relayMode.checked ? "relay" : "all",
    };
  },
  onChannel: (channel, generation, isInitiator) => {
    connected = true;
    transfer.attachChannel(channel, generation);
    transfer.bindChannelEvents(channel);
    setStatus("DataChannel 已打开，开始交换流标识并恢复可续传任务。", "success");
    updateButtons();
  },
  onStatus: handleConnectionStatus,
});

const transfer = new TransferManager({
  entries,
  onRender: renderQueue,
  onStatus: (message, kind) => setStatus(message, kind),
  refreshStorage: refreshStorage,
});

elements.hostTab.addEventListener("click", () => setRole("host"));
elements.guestTab.addEventListener("click", () => setRole("guest"));
elements.createOffer.addEventListener("click", guard(createOffer));
elements.createAnswer.addEventListener("click", guard(createAnswer));
elements.acceptAnswer.addEventListener("click", guard(acceptAnswer));
elements.restartIce.addEventListener("click", guard(restartIce));
elements.relayFallback.addEventListener("click", guard(relayFallback));
elements.newConnection.addEventListener("click", guard(resetConnection));
elements.copyLocal.addEventListener("click", copyLocalSdp);
elements.pasteRemote.addEventListener("click", pasteRemoteSdp);

elements.dropZone.addEventListener("click", () => elements.fileInput.click());
elements.dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") elements.fileInput.click();
});
elements.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("dragover");
});
elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragover"));
elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragover");
  addFiles(event.dataTransfer.files);
});
elements.fileInput.addEventListener("change", () => addFiles(elements.fileInput.files));
elements.sendQueue.addEventListener("click", () => transfer.activateNextSender());
elements.pauseQueue.addEventListener("click", () => {
  if (transfer.activeFile?.status === "sending") transfer.pauseActive(true);
  else if (transfer.activeFile?.status === "paused" && !transfer.activeFile.manualPause) transfer.pauseActive(true);
  else transfer.resumeActive();
});
elements.clearDone.addEventListener("click", () => {
  for (const entry of [...entries]) {
    if (entry.status === "complete" && entry.role === "sender") entries.splice(entries.indexOf(entry), 1);
  }
  renderQueue();
});

setRole("host");
await boot();

async function boot() {
  await scanReceivedFiles();
  for (const metadata of receiverStates.values()) {
    entries.push(createReceiverEntry(metadata));
  }
  renderQueue();
  refreshStorage();
}

function setRole(nextRole) {
  role = nextRole;
  elements.hostTab.classList.toggle("active", role === "host");
  elements.guestTab.classList.toggle("active", role === "guest");
  const hostHint = "1. 发起方创建 Offer 并复制给对方；2. 对方粘贴 Offer 生成 Answer；3. 发起方粘贴 Answer 并应用。";
  const guestHint = "1. 粘贴发起方的 Offer；2. 点击生成 Answer 并复制回去；3. 等待发起方应用 Answer。";
  setStatus(role === "host" ? hostHint : guestHint, "info");
  updateButtons();
}

async function createOffer() {
  elements.localSdp.value = "";
  const sdp = await signaling.createOffer();
  elements.localSdp.value = sdp;
  setStatus("Offer 已生成并等待 ICE 候选收集，请复制本机 SDP 给另一台设备。", "info");
}

async function createAnswer() {
  const offer = normalizeSdp(elements.remoteSdp.value);
  const sdp = await signaling.createAnswer(offer, elements.relayMode.checked);
  elements.localSdp.value = sdp;
  setStatus("Answer 已生成，请复制回发起方并应用。", "success");
}

async function acceptAnswer() {
  const answer = normalizeSdp(elements.remoteSdp.value);
  await signaling.acceptAnswer(answer);
  setStatus("Answer 已应用，正在等待 ICE 建立。若出现 failed，请尝试 ICE 重启或配置 TURN 后走中继。", "info");
}

async function restartIce() {
  if (role !== "host") {
    setStatus("ICE 重启需要发起方生成新 Offer；接收方粘贴后再次生成 Answer。", "warning");
    return;
  }
  const sdp = await signaling.restartOffer();
  elements.localSdp.value = sdp;
  elements.remoteSdp.value = "";
  setStatus("已在原连接上生成 ICE 重启 Offer。请重新复制给对方生成 Answer，再粘贴回来应用；文件进度不会清空。", "warning");
}

async function relayFallback() {
  if (role === "host") {
    elements.relayMode.checked = true;
    await resetConnection(false);
    const sdp = await signaling.createOffer();
    elements.localSdp.value = sdp;
    elements.remoteSdp.value = "";
    setStatus("已切换为仅 TURN 中继并生成新 Offer。请确认 JSON 中包含可用 TURN 账号，然后重新交换 SDP。", "warning");
  } else {
    elements.relayMode.checked = true;
    setStatus("接收端已切换为仅 TURN 中继。请粘贴发起方的中继 Offer，再生成 Answer。", "warning");
  }
}

async function resetConnection(showMessage = true) {
  connected = false;
  transfer.detachChannel();
  await signaling.close(true);
  elements.pill.textContent = "未连接";
  elements.pill.className = "connection-pill";
  if (showMessage) setStatus("旧 PeerConnection 已关闭。可由发起方创建新 Offer；已落盘的接收进度仍会在新通道中复用。", "info");
  updateButtons();
}

async function addFiles(fileList) {
  for (const file of Array.from(fileList)) {
    const chunkSize = Number(elements.chunkSize.value);
    const entry = createSenderEntry(file, chunkSize);
    entry.fileId = await fileIdFor(file);
    const existing = entries.find((item) => item.fileId === entry.fileId && item.role === "sender");
    if (existing) {
      existing.file = file;
      existing.chunkSize = chunkSize;
      existing.status = existing.status === "error" ? "paused" : existing.status;
      existing.error = "已重新选择本地文件，可继续断点续传";
      continue;
    }
    entries.push(entry);
  }
  renderQueue();
}

function handleConnectionStatus(state, source) {
  if (state === "open") {
    connected = true;
    elements.pill.textContent = "已连接";
    elements.pill.className = "connection-pill open";
  } else if (state === "connecting" || state === "new" || state === "disconnected" || state === "checking") {
    elements.pill.textContent = state === "disconnected" ? "网络断开，等待恢复" : "连接中";
    elements.pill.className = "connection-pill connecting";
    if (state === "disconnected") setStatus("ICE 连接暂时断开。不要关闭页面，先等待恢复；若变为 failed，可 ICE 重启或 TURN 降级。", "warning");
  } else if (state === "failed") {
    elements.pill.textContent = "ICE 失败";
    elements.pill.className = "connection-pill failed";
    setStatus("ICE 失败：当前 STUN/直连路径不可达。请检查网络；跨对称 NAT 时配置 TURN，点击“降级为 TURN 中继”后重新交换 SDP。", "error");
  } else if (state === "closed" || state === "error") {
    connected = false;
    elements.pill.textContent = state === "error" ? "通道错误" : "连接关闭";
    elements.pill.className = "connection-pill failed";
    transfer.detachChannel();
  } else if (state === "buffered-low") {
    transfer.pump();
  }
  updateButtons();
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(error);
      setStatus(error.message || String(error), "error");
    }
  };
}

async function copyLocalSdp() {
  if (!elements.localSdp.value) return;
  await navigator.clipboard.writeText(elements.localSdp.value);
  setStatus("本机 SDP 已复制。", "success");
}

async function pasteRemoteSdp() {
  elements.remoteSdp.value = await navigator.clipboard.readText();
  setStatus("已从剪贴板粘贴对方 SDP。", "success");
}

function setStatus(message, kind = "info") {
  elements.status.textContent = message;
  elements.status.className = `status-alert ${kind}`;
}

function updateButtons() {
  elements.restartIce.disabled = role !== "host" || !signaling.pc;
  elements.relayFallback.disabled = false;
  elements.sendQueue.disabled = !transfer.channel || transfer.channel.readyState !== "open" || !transfer.peerStreamId;
  const active = transfer.activeFile;
  elements.pauseQueue.disabled = !(active?.role === "sender" && ["sending", "paused"].includes(active.status));
  elements.pauseQueue.textContent = active?.status === "paused" ? "继续" : "暂停";
}

function renderQueue() {
  updateButtons();
  if (!entries.length) {
    elements.queue.innerHTML = `<div class="empty-queue">暂无文件。发送端添加文件；接收端收到清单后会自动出现在这里。</div>`;
    return;
  }
  elements.queue.textContent = "";
  for (const entry of entries) elements.queue.appendChild(renderRow(entry));
}

function renderRow(entry) {
  const node = elements.rowTemplate.content.firstElementChild.cloneNode(true);
  const done = entry.bytesAcked || 0;
  const percent = entry.size ? Math.min(100, (done / entry.size) * 100) : 0;
  node.querySelector(".file-name").textContent = `${entry.role === "sender" ? "发送" : "接收"} · ${entry.name}`;
  node.querySelector(".file-size").textContent = formatBytes(entry.size);
  node.querySelector(".progress-bar").style.width = `${percent}%`;
  node.querySelector(".file-state").textContent = statusText(entry);
  node.querySelector(".file-progress-text").textContent = `${percent.toFixed(2)}% · ${formatBytes(done)} / ${formatBytes(entry.size)}`;
  node.querySelector(".file-speed").textContent = entry.status === "complete" ? "" : `速度 ${formatSpeed(entry.speed || 0)}`;
  node.querySelector(".file-buffer").textContent = entry.role === "sender" && entry.status === "sending" ? `buffer ${formatBytes(entry.buffered || 0)}` : "";
  node.querySelector(".file-hash").textContent = entry.status === "error" ? (entry.error || "发生错误") : (entry.hashText || entry.error || "等待开始");
  const actions = node.querySelector(".file-actions");
  appendAction(actions, "取消", () => transfer.cancelActive(entry.fileId));
  if (entry.role === "sender") {
    if (entry.status === "sending") appendAction(actions, "暂停", () => transfer.pauseActive(true));
    if (entry.status === "paused") appendAction(actions, "继续", () => transfer.resumeActive());
  }
  if (entry.role === "receiver" && ["paused", "error"].includes(entry.status)) {
    appendAction(actions, "请求续传", () => transfer.resumeReceiver(entry.fileId));
  }
  if (entry.role === "receiver" && entry.status === "complete") {
    appendAction(actions, "保存", () => transfer.saveReceived(entry.fileId));
    appendAction(actions, "删除", () => transfer.deleteReceived(entry.fileId));
  }
  return node;
}

function appendAction(container, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  container.appendChild(button);
}

function statusText(entry) {
  const labels = {
    queued: "排队中",
    offered: "已发送清单",
    sending: entry.role === "sender" ? "发送中" : "接收中",
    receiving: "接收中",
    preparing: "准备存储",
    verifying: "等待最终哈希",
    paused: "已暂停/可续传",
    error: "错误",
    complete: "完成并校验",
  };
  return labels[entry.status] || entry.status;
}

async function refreshStorage() {
  elements.storageInfo.textContent = await storageSummary();
}
