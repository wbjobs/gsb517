import { HEADER_BYTES, decodeHeader, encodeHeader, postJson, shortId } from "./utils.js";

const MAX_QUEUE_CHUNKS = 8;
const STOP_BUFFER = 1024 * 1024;
const RESUME_BUFFER = 384 * 1024;

export class TransferManager {
  constructor({ entries, onRender, onStatus, refreshStorage }) {
    this.entries = entries;
    this.onRender = onRender;
    this.onStatus = onStatus;
    this.refreshStorage = refreshStorage;
    this.channel = null;
    this.generation = -1;
    this.localStreamId = "";
    this.peerStreamId = "";
    this.senderWorker = new Worker("js/sender-worker.js", { type: "module" });
    this.receiverWorker = new Worker("js/receiver-worker.js", { type: "module" });
    this.activeSenderId = null;
    this.activeFile = null;
    this.activeReceiverId = null;
    this.pendingChunks = [];
    this.queuedBytes = 0;
    this.inFlight = 0;
    this.senderCredits = 0;
    this.outstandingReads = 0;
    this.pausedByUser = false;
    this.draining = false;
    this.manualTick = setInterval(() => this.tick(), 500);
    this.bindWorkers();
  }

  bindWorkers() {
    this.senderWorker.onmessage = (event) => this.handleSenderWorker(event.data);
    this.receiverWorker.onmessage = (event) => this.handleReceiverWorker(event.data);
    this.senderWorker.onerror = (event) => {
      if (this.activeFile) {
        this.activeFile.status = "error";
        this.activeFile.error = event.message || "发送 Worker 发生错误";
        this.resetPump();
        this.render();
      }
    };
    this.receiverWorker.onerror = (event) => {
      const entry = this.entries.find((item) => item.fileId === this.activeReceiverId && item.role === "receiver");
      if (entry) {
        entry.status = "error";
        entry.error = event.message || "接收 Worker 发生错误";
        this.render();
      }
    };
  }

  attachChannel(channel, generation) {
    this.channel = channel;
    this.generation = generation;
    this.localStreamId = shortId();
    this.peerStreamId = "";
    this.pendingChunks.length = 0;
    this.queuedBytes = 0;
    this.inFlight = 0;
    this.senderCredits = 0;
    this.outstandingReads = 0;
    postJson(this.channel, "hello", { streamId: this.localStreamId });
    if (this.activeFile && !this.activeFile.manualPause && ["sending", "paused", "error", "offered", "verifying"].includes(this.activeFile.status)) {
      postJson(this.channel, "file-resync", this.fileMeta(this.activeFile));
    }
    if (!this.activeFile) this.activateNextSender();
    this.render();
  }

  detachChannel() {
    this.channel = null;
    this.pendingChunks.length = 0;
    this.queuedBytes = 0;
    this.inFlight = 0;
    this.senderCredits = 0;
    this.outstandingReads = 0;
    if (this.activeFile) this.senderWorker.postMessage({ type: "pause" });
    for (const entry of this.entries) {
      if (entry.role === "sender" && entry.status === "sending") {
        entry.manualPause = false;
        entry.status = "paused";
        entry.error = "DataChannel 已关闭，保留已确认进度";
      }
      if (entry.role === "receiver" && entry.status === "receiving") entry.status = "paused";
    }
    this.render();
  }

  handleControl(message) {
    switch (message.type) {
      case "hello":
        this.peerStreamId = message.streamId;
        postJson(this.channel, "hello-ack", { streamId: this.localStreamId });
        this.render();
        break;
      case "hello-ack":
        this.peerStreamId = message.streamId;
        this.render();
        break;
      case "file-offer":
        this.handleFileOffer(message);
        break;
      case "file-accepted":
        if (this.activeFile?.fileId === message.fileId) {
          this.startSenderAt(message.resumeIndex || 0, message.resumeOffset || 0);
        }
        break;
      case "file-resync":
        this.handleResync(message);
        break;
      case "file-final": {
        const fullHashBytes = hexToBuffer(message.fullHash);
        this.receiverWorker.postMessage({
          type: "finalize",
          fileId: message.fileId,
          fullHash: fullHashBytes,
          zero: false,
          streamId: this.localStreamId,
        }, [fullHashBytes.buffer]);
        break;
      }
      case "resume-request":
        if (this.activeFile?.fileId === message.fileId) {
          this.startSenderAt(message.resumeIndex, message.resumeOffset);
        }
        break;
      case "file-checkpoint":
        this.handleCheckpoint(message);
        break;
      case "file-complete":
        this.handlePeerComplete(message);
        break;
      case "cancel-file":
        this.handleRemoteCancel(message.fileId);
        break;
      default:
        break;
    }
    this.render();
  }

  handleBinary(arrayBuffer) {
    const headerBuffer = arrayBuffer.slice(0, HEADER_BYTES);
    const payloadBuffer = arrayBuffer.slice(HEADER_BYTES);
    const header = decodeHeader(headerBuffer);
    if (!header || header.streamId !== this.peerStreamId || header.generation !== this.generation) return;
    if (header.payloadLength !== payloadBuffer.byteLength) {
      this.onStatus("收到长度不一致的分块，已丢弃", "error");
      return;
    }
    const entry = this.entries.find((item) => item.fileId === header.fileId && item.role === "receiver");
    if (!entry) return;
    this.activeReceiverId = entry.fileId;
    this.receiverWorker.postMessage({
      type: "chunk",
      fileId: entry.fileId,
      chunk: {
        index: header.index,
        offset: header.offset,
        payload: payloadBuffer,
        chunkHash: header.chunkHash,
      },
      streamId: this.localStreamId,
    }, [payloadBuffer]);
  }

  bindChannelEvents() {
    this.channel.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.handleControl(JSON.parse(event.data));
      else this.handleBinary(event.data);
    });
  }

  sendNextQueued(entry) {
    if (entry !== this.activeFile || !this.peerStreamId) return;
    if (this.activeSenderId !== entry.fileId) {
      this.activeSenderId = entry.fileId;
      entry.status = "offered";
      postJson(this.channel, "file-offer", this.fileMeta(entry));
      return;
    }
    if (!["queued", "offered", "sending"].includes(entry.status)) return;
    entry.status = "sending";
    this.pump();
  }

  pauseActive(manual = true) {
    const entry = this.activeFile;
    if (!entry || entry.role !== "sender") return;
    if (manual) this.pausedByUser = true;
    entry.manualPause = manual;
    entry.status = "paused";
    entry.error = manual ? "已手动暂停" : "等待连接恢复";
    this.senderWorker.postMessage({ type: "pause" });
    this.resetPump();
    this.render();
  }

  resumeActive() {
    const entry = this.activeFile;
    if (!entry || entry.role !== "sender" || !this.channel || this.channel.readyState !== "open") return;
    this.pausedByUser = false;
    entry.manualPause = false;
    entry.status = "offered";
    entry.error = "";
    postJson(this.channel, "file-resync", this.fileMeta(entry));
  }

  resumeReceiver(fileId) {
    const entry = this.entries.find((item) => item.fileId === fileId && item.role === "receiver");
    if (!entry || !this.channel || this.channel.readyState !== "open") return;
    entry.status = "paused";
    entry.error = "";
    postJson(this.channel, "resume-request", {
      fileId,
      resumeIndex: entry.expectedIndex || 0,
      resumeOffset: entry.bytesAcked || 0,
    });
    this.render();
  }

  cancelActive(fileId) {
    const entry = this.entries.find((item) => item.fileId === fileId);
    if (!entry) return;
    if (entry.role === "sender" && this.activeFile === entry) {
      this.senderWorker.postMessage({ type: "cancel" });
      this.resetPump();
    }
    if (entry.role === "receiver") {
      this.receiverWorker.postMessage({ type: "remove", fileId });
    }
    postJson(this.channel, "cancel-file", { fileId });
    this.removeEntry(fileId);
  }

  removeLocalEntry(fileId) {
    this.removeEntry(fileId);
  }

  removeEntry(fileId) {
    const index = this.entries.findIndex((item) => item.fileId === fileId);
    if (index >= 0) this.entries.splice(index, 1);
    if (this.activeFile?.fileId === fileId) {
      this.activeFile = null;
      this.activeSenderId = null;
      this.resetPump();
      this.advanceQueue();
    }
    this.render();
  }

  saveReceived(fileId) {
    const entry = this.entries.find((item) => item.fileId === fileId && item.role === "receiver");
    if (!entry || entry.status !== "complete") return;
    navigator.storage.getDirectory().getFileHandle(fileId).then(async (handle) => {
      const opfsFile = await handle.getFile();
      const url = URL.createObjectURL(opfsFile);
      const link = document.createElement("a");
      link.href = url;
      link.download = entry.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }).catch((error) => this.onStatus(error.message, "error"));
  }

  deleteReceived(fileId) {
    this.receiverWorker.postMessage({ type: "remove", fileId });
  }

  async handleFileOffer(metadata) {
    let entry = this.entries.find((item) => item.fileId === metadata.fileId && item.role === "receiver");
    if (!entry) {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const available = (estimate.quota || 0) - (estimate.usage || 0);
        if (estimate.quota && available < metadata.size) {
          this.onStatus(`OPFS 可用空间约 ${available} 字节，不足 ${metadata.size} 字节`, "error");
          return;
        }
      }
      entry = {
        role: "receiver",
        file: null,
        fileId: metadata.fileId,
        name: metadata.name,
        size: metadata.size,
        lastModified: metadata.lastModified,
        chunkSize: metadata.chunkSize,
        status: "preparing",
        bytesSent: 0,
        bytesAcked: 0,
        expectedIndex: 0,
        speed: 0,
        buffered: 0,
        hashText: "正在初始化 OPFS 断点文件",
        error: "",
      };
      this.entries.push(entry);
    }
    this.activeReceiverId = entry.fileId;
    this.activeSenderId = null;
    this.receiverWorker.postMessage({ type: "prepare", ...metadata, streamId: this.localStreamId });
  }

  async handleResync(metadata) {
    const entry = this.entries.find((item) => item.fileId === metadata.fileId && item.role === "receiver");
    if (entry?.status === "complete") {
      postJson(this.channel, "file-complete", { fileId: entry.fileId, fullHash: entry.hashText.replace("SHA-256 一致：", "") });
      return;
    }
    if (!entry) {
      await this.handleFileOffer(metadata);
      return;
    }
    this.activeReceiverId = entry.fileId;
    this.activeSenderId = null;
    this.receiverWorker.postMessage({ type: "prepare", ...metadata, streamId: this.localStreamId });
  }

  startSenderAt(resumeIndex, resumeOffset) {
    const entry = this.activeFile;
    if (!entry || entry.role !== "sender" || !entry.file) return;
    if (resumeOffset >= entry.size && entry.fullHash) {
      entry.status = "verifying";
      entry.bytesSent = entry.size;
      entry.bytesAcked = entry.size;
      entry.error = "";
      postJson(this.channel, "file-final", { fileId: entry.fileId, fullHash: entry.fullHash });
      this.render();
      return;
    }
    this.pausedByUser = false;
    entry.manualPause = false;
    entry.status = "sending";
    entry.expectedIndex = resumeIndex;
    entry.bytesSent = resumeOffset;
    entry.bytesAcked = resumeOffset;
    entry.error = "";
    this.resetPump();
    this.senderWorker.postMessage({
      type: "start",
      file: entry.file,
      fileId: entry.fileId,
      chunkSize: entry.chunkSize,
      startIndex: resumeIndex,
      startOffset: resumeOffset,
    });
    this.render();
  }

  resetPump() {
    this.pendingChunks.length = 0;
    this.queuedBytes = 0;
    this.inFlight = 0;
    this.senderCredits = 0;
    this.outstandingReads = 0;
  }

  pump() {
    const entry = this.activeFile;
    if (!entry || entry.role !== "sender" || entry.status !== "sending" || !this.channel || this.channel.readyState !== "open") return;
    if (this.pausedByUser) return;
    this.drainQueue();
    const buffered = this.channel.bufferedAmount + this.queuedBytes;
    entry.buffered = buffered;
    if (buffered > STOP_BUFFER) {
      this.draining = true;
      entry.error = "bufferedAmount 超过 1 MiB，已背压暂停读取和发送";
      this.render();
      return;
    }
    if (this.draining && buffered <= RESUME_BUFFER) this.draining = false;
    const targetWindow = this.draining ? 0 : MAX_QUEUE_CHUNKS;
    const creditsAvailable = targetWindow - this.inFlight - this.pendingChunks.length - this.outstandingReads;
    if (creditsAvailable > 0) {
      this.outstandingReads += creditsAvailable;
      this.senderWorker.postMessage({ type: "fill", credits: creditsAvailable });
    }
    if (!this.draining) entry.error = "";
    this.render();
  }

  drainQueue() {
    while (this.pendingChunks.length) {
      const queued = this.pendingChunks[0];
      const frameLength = HEADER_BYTES + queued.chunk.payload.byteLength;
      if (this.channel.bufferedAmount + this.queuedBytes + frameLength > STOP_BUFFER) break;
      this.pendingChunks.shift();
      this.queuedBytes -= HEADER_BYTES + queued.chunk.payload.byteLength;
      const header = encodeHeader({
        streamId: this.peerStreamId,
        fileId: queued.fileId,
        index: queued.chunk.index,
        offset: queued.chunk.offset,
        payloadLength: queued.chunk.payload.byteLength,
        chunkHash: queued.chunk.chunkHash,
        generation: this.generation,
      });
      const frame = new Uint8Array(frameLength);
      frame.set(new Uint8Array(header), 0);
      frame.set(new Uint8Array(queued.chunk.payload), HEADER_BYTES);
      this.channel.send(frame.buffer);
      this.inFlight += 1;
      if (queued.chunk.final) {
        const finalEntry = this.entries.find((item) => item.fileId === queued.fileId);
        if (finalEntry) {
          finalEntry.fullHash = bufferToHex(queued.chunk.fullHash);
          postJson(this.channel, "file-final", { fileId: queued.fileId, fullHash: finalEntry.fullHash });
        }
      }
    }
  }

  tick() {
    for (const entry of this.entries) {
      if (this.channel) entry.buffered = entry.role === "sender" ? this.channel.bufferedAmount : 0;
    }
    if (this.activeFile?.status === "sending" && !this.pausedByUser && this.channel?.readyState === "open") this.pump();
    this.render();
  }

  handleSenderWorker(message) {
    const entry = this.entries.find((item) => item.fileId === message.fileId && item.role === "sender");
    if (!entry) return;
    if (message.type === "ready") {
      this.activeFile = entry;
      this.activeSenderId = entry.fileId;
      entry.status = "sending";
      entry.expectedIndex = message.index;
      entry.bytesSent = message.offset;
      entry.bytesAcked = Math.max(entry.bytesAcked, message.offset);
      this.resetPump();
      this.pump();
      return;
    }
    if (message.type === "chunk") {
      const bytes = HEADER_BYTES + message.chunk.payload.byteLength;
      this.pendingChunks.push(message);
      this.queuedBytes += bytes;
      this.outstandingReads = Math.max(0, this.outstandingReads - (message.chunk.payload.byteLength ? 1 : 0));
      entry.bytesSent = message.chunk.offset + message.chunk.payload.byteLength;
      if (message.chunk.zeroFile) {
        entry.fullHash = bufferToHex(message.chunk.fullHash);
        postJson(this.channel, "file-final", { fileId: message.fileId, fullHash: entry.fullHash, zero: true, name: entry.name });
        this.pendingChunks.pop();
        this.queuedBytes -= bytes;
        return;
      }
      this.drainQueue();
      this.pump();
    }
  }

  handleReceiverWorker(message) {
    const entry = this.entries.find((item) => item.fileId === message.fileId && item.role === "receiver");
    if (message.type === "ready") {
      const target = entry || this.entries.find((item) => item.fileId === this.activeReceiverId && item.role === "receiver");
      if (!target) return;
      target.status = "receiving";
      target.expectedIndex = message.resumeIndex;
      target.bytesAcked = message.resumeOffset;
      target.bytesSent = message.resumeOffset;
      target.size = target.size || 0;
      target.hashText = message.saved ? `从 OPFS 偏移 ${message.resumeOffset} 续传` : "接收端已准备好";
      target.error = "";
      postJson(this.channel, "file-accepted", {
        fileId: target.fileId,
        resumeIndex: message.resumeIndex,
        resumeOffset: message.resumeOffset,
      });
      this.render();
      return;
    }
    if (message.type === "ack" && entry) {
      const now = performance.now();
      const deltaBytes = message.bytesWritten - entry.bytesAcked;
      if (entry.lastAckTime) {
        const seconds = (now - entry.lastAckTime) / 1000;
        if (seconds > 0) entry.speed = entry.speed ? entry.speed * 0.75 + (deltaBytes / seconds) * 0.25 : deltaBytes / seconds;
      }
      entry.lastAckTime = now;
      entry.bytesAcked = message.bytesWritten;
      entry.bytesSent = Math.max(entry.bytesSent, message.bytesWritten);
      if (this.activeReceiverId === entry.fileId) {
        postJson(this.channel, "file-checkpoint", {
          fileId: entry.fileId,
          ackIndex: message.ackIndex,
          bytesWritten: message.bytesWritten,
          final: message.final,
        });
      }
      this.render();
      return;
    }
    if (message.type === "complete" && entry) {
      entry.status = "complete";
      entry.bytesAcked = entry.size;
      entry.bytesSent = entry.size;
      entry.speed = 0;
      entry.lastAckTime = 0;
      entry.hashText = `SHA-256 一致：${message.fullHash}`;
      entry.error = "";
      postJson(this.channel, "file-complete", { fileId: entry.fileId, fullHash: message.fullHash });
      this.activeReceiverId = null;
      this.advanceQueue();
      this.refreshStorage?.();
      this.render();
      return;
    }
    if (message.type === "removed") {
      this.removeEntry(message.fileId);
      this.refreshStorage?.();
      return;
    }
    if (message.type === "resync" && entry) {
      entry.status = "paused";
      entry.hashText = "收到乱序分块，正在请求发送端从确认点续传";
      postJson(this.channel, "resume-request", {
        fileId: entry.fileId,
        resumeIndex: message.resumeIndex,
        resumeOffset: message.resumeOffset,
      });
      this.render();
      return;
    }
    if (message.type === "error" && entry) {
      entry.status = "error";
      entry.error = message.message;
      this.render();
    }
  }

  handleCheckpoint(message) {
    const entry = this.entries.find((item) => item.fileId === message.fileId && item.role === "sender");
    if (!entry) return;
    const now = performance.now();
    const deltaBytes = Math.max(0, message.bytesWritten - entry.bytesAcked);
    if (entry.lastAckTime && deltaBytes > 0) {
      const seconds = (now - entry.lastAckTime) / 1000;
      if (seconds > 0) entry.speed = entry.speed ? entry.speed * 0.75 + (deltaBytes / seconds) * 0.25 : deltaBytes / seconds;
    }
    if (deltaBytes > 0) entry.lastAckTime = now;
    entry.bytesAcked = Math.max(entry.bytesAcked, message.bytesWritten);
    const unacknowledgedChunks = Math.max(0, Math.ceil(Math.max(0, entry.bytesSent - entry.bytesAcked) / entry.chunkSize));
    this.inFlight = Math.min(MAX_QUEUE_CHUNKS, unacknowledgedChunks);
    if (message.final) entry.status = "verifying";
    this.pump();
  }

  handlePeerComplete(message) {
    const entry = this.entries.find((item) => item.fileId === message.fileId && item.role === "sender");
    if (!entry) return;
    entry.status = "complete";
    entry.bytesAcked = entry.size;
    entry.bytesSent = entry.size;
    entry.speed = 0;
    entry.lastAckTime = 0;
    entry.hashText = `对端已校验：SHA-256 ${message.fullHash}`;
    entry.error = "";
    this.activeFile = null;
    this.activeSenderId = null;
    this.resetPump();
    this.advanceQueue();
  }

  handleRemoteCancel(fileId) {
    const entry = this.entries.find((item) => item.fileId === fileId);
    if (!entry) return;
    if (entry.role === "sender") {
      this.senderWorker.postMessage({ type: "cancel" });
      this.resetPump();
    } else {
      this.receiverWorker.postMessage({ type: "remove", fileId });
    }
    this.removeEntry(fileId);
  }

  activateNextSender() {
    if (this.activeFile || !this.channel || this.channel.readyState !== "open") return;
    const next = this.entries.find((entry) => entry.role === "sender" && (entry.status === "queued" || (entry.status === "paused" && !entry.manualPause)));
    if (!next) return;
    this.activeFile = next;
    this.activeSenderId = null;
    this.pausedByUser = false;
    this.sendNextQueued(next);
  }

  advanceQueue() {
    this.activateNextSender();
    this.render();
  }

  fileMeta(entry) {
    return {
      fileId: entry.fileId,
      name: entry.name,
      size: entry.size,
      lastModified: entry.lastModified,
      chunkSize: Number(entry.chunkSize),
    };
  }

  render() {
    this.onRender?.();
  }
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
