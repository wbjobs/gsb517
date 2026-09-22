"use strict";

class SenderManager extends EventTarget {
  constructor(connection) {
    super();
    this.connection = connection;
    this.hash = new HashClient();
    this.files = [];
    this.current = null;
    this.pumping = false;
    this.connected = false;
    this.lastSave = 0;
    this.load();

    connection.addEventListener("dataopen", () => {
      this.connected = true;
      this.safeSend({ type: "hello", protocol: 1, role: "sender" });
      if (this.current && ["sending", "waiting"].includes(this.current.status)) {
        this.resumeCurrent();
      } else if (this.current && this.current.status === "verifying") {
        const file = this.current;
        if (file.fullHash) this.safeSend({ type: "file-end", fileId: file.id, fullHash: file.fullHash });
      } else {
        this.startQueue();
      }
    });
    connection.addEventListener("dataclosed", () => this.handleDisconnect());
    connection.addEventListener("bufferedlow", () => this.pump());
    connection.addEventListener("datamessage", event => this.handleMessage(event.detail.data));
  }

  load() {
    const data = appUtils.loadJson(appUtils.SENDER_KEY, { files: [] });
    this.files = data.files.map(file => ({
      ...file,
      file: null,
      inflight: new Map(),
      inFlightBytes: 0,
      hasherId: null,
      accepted: false,
      priming: false,
      hashOperation: null,
      primeGeneration: 0,
      endSent: file.status === "done"
    }));
    this.current = this.files.find(file =>
      ["sending", "verifying", "waiting"].includes(file.status)) || null;
    if (this.current) this.current.status = this.current.file ? "sending" : "needs_file";
  }

  persist(force = false) {
    const now = Date.now();
    if (!force && now - this.lastSave < 500) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.persist(true), 500);
      return;
    }
    this.lastSave = now;
    const files = this.files.map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      durable: file.durable,
      status: file.status,
      fullHash: file.fullHash,
      error: file.error || ""
    }));
    appUtils.saveJson(appUtils.SENDER_KEY, { files });
  }

  async makeFileId(file) {
    const metadata = new TextEncoder().encode(
      [file.name, file.lastModified, file.size, file.type].join("\u0000")
    );
    return createSha256().update(metadata).hex().slice(0, 32);
  }

  async addFiles(fileList) {
    for (const file of Array.from(fileList)) {
      const id = await this.makeFileId(file);
      const existing = this.files.find(item => item.id === id);
      if (existing) {
        existing.file = file;
        existing.error = "";
        if (existing.status === "done") {
          existing.status = "queued";
          existing.durable = 0;
          existing.fullHash = "";
          existing.endSent = false;
          this.startQueue();
        } else if (existing === this.current) {
          existing.status = "sending";
          if (this.connected) this.resumeCurrent();
        } else if (["needs_file", "waiting", "error"].includes(existing.status)) {
          existing.status = "queued";
        }
      } else {
        this.files.push({
          id,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          durable: 0,
          status: "queued",
          fullHash: "",
          error: "",
          file,
          inflight: new Map(),
          inFlightBytes: 0,
          hasherId: null,
          accepted: false,
          priming: false,
          hashOperation: null,
          primeGeneration: 0,
          endSent: false
        });
      }
    }
    this.persist(true);
    this.emitChange();
    this.startQueue();
  }

  removeFile(id) {
    if (this.current && this.current.id === id) return;
    this.files = this.files.filter(item => item.id !== id);
    this.persist(true);
    this.emitChange();
  }

  clearFinished() {
    this.files = this.files.filter(file => file.status !== "done");
    this.persist(true);
    this.emitChange();
  }

  startQueue() {
    if (!this.connected || this.current) return;
    const file = this.files.find(item => item.status === "queued" && item.file);
    if (!file) return;
    this.current = file;
    file.status = "sending";
    file.error = "";
    this.persist(true);
    this.emitChange();
    this.resumeCurrent();
  }

  resumeCurrent() {
    const file = this.current;
    if (!file) return;
    if (!file.file) {
      file.status = "needs_file";
      this.persist(true);
      this.emitChange();
      return;
    }
    file.inflight.clear();
    file.inFlightBytes = 0;
    file.accepted = false;
    file.priming = false;
    file.status = "sending";
    if (file.hasherId) this.hash.dispose(file.hasherId);
    this.emitChange();
    if (this.connected) {
      this.safeSend({
        type: "file-start",
        fileId: file.id,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        chunkSize: this.chunkSize
      });
    }
    this.pump();
  }

  handleDisconnect() {
    this.connected = false;
    if (this.current) {
      const file = this.current;
      if (file.status === "verifying") {
        this.emitChange();
        return;
      }
      file.inflight.clear();
      file.inFlightBytes = 0;
      file.accepted = false;
      file.priming = false;
      file.status = "waiting";
      if (file.hasherId) this.hash.dispose(file.hasherId);
      file.hasherId = null;
      this.persist(true);
    }
    this.emitChange();
  }

  get chunkSize() {
    return 64 * 1024;
  }

  get windowBytes() {
    return 8 * 1024 * 1024;
  }

  get bufferLimit() {
    return 1024 * 1024;
  }

  safeSend(message) {
    try {
      this.connection.sendJson(message);
      return true;
    } catch (error) {
      this.emitLog(`发送控制消息失败：${error.message}`);
      return false;
    }
  }

  async primeHasher(file, targetOffset, force = false) {
    if (file.priming && !force) return;
    const generation = (file.primeGeneration || 0) + 1;
    file.primeGeneration = generation;
    file.priming = true;
    targetOffset = Math.min(targetOffset, file.size);
    if (file.hasherId) await this.hash.dispose(file.hasherId);
    const hasher = await this.hash.create();
    file.hasherId = hasher.id;
    let initialized = false;

    let offset = 0;
    while (offset < targetOffset) {
      if (generation !== file.primeGeneration) return;
      const end = Math.min(offset + this.chunkSize, targetOffset);
      const buffer = await file.file.slice(offset, end).arrayBuffer();
      if (generation !== file.primeGeneration) return;
      await this.hash.prime(file.hasherId, offset, buffer);
      offset = end;
      initialized = true;
    }
    if (!initialized) await this.hash.prime(file.hasherId, 0, new ArrayBuffer(0)).catch(() => {});
    if (generation !== file.primeGeneration) return;
    file.durable = targetOffset;
    file.priming = false;
    this.persist();
    this.emitChange();
  }

  async pump() {
    if (this.pumping) return;
    const file = this.current;
    if (!file || !this.connected || !file.file || file.status === "verifying") return;
    this.pumping = true;
    try {
      while (true) {
        if (!this.connected || this.current !== file) break;
        if (!file.accepted || file.priming || file.hashOperation) break;

        const logicalOffset = file.durable + file.inFlightBytes;
        if (logicalOffset >= file.size) break;
        if (file.inFlightBytes >= this.windowBytes) break;
        if (this.connection.bufferedAmount >= this.bufferLimit) break;

        const end = Math.min(logicalOffset + this.chunkSize, file.size);
        const buffer = await file.file.slice(logicalOffset, end).arrayBuffer();
        const operation = this.hash.update(file.hasherId, logicalOffset, buffer);
        file.hashOperation = operation;
        const result = await operation;
        file.hashOperation = null;
        if (!this.connected || this.current !== file) break;

        if (!this.safeSend({
          type: "chunk",
          fileId: file.id,
          offset: logicalOffset,
          end,
          hash: result.chunkHash
        })) break;

        try {
          this.connection.send(result.buffer);
        } catch (error) {
          this.handleDisconnect();
          break;
        }

        file.inflight.set(logicalOffset, { end, hash: result.chunkHash });
        file.inFlightBytes += end - logicalOffset;
        this.emitChange();
      }
    } catch (error) {
      file.status = "error";
      file.error = error.message || String(error);
      this.persist(true);
      this.emitLog(`发送失败：${file.error}`);
      this.emitChange();
    } finally {
      this.pumping = false;
    }
  }

  async finishFile(file) {
    file.status = "verifying";
    const result = await this.hash.finish(file.hasherId);
    file.hasherId = null;
    file.fullHash = result.fullHash;
    this.safeSend({ type: "file-end", fileId: file.id, fullHash: file.fullHash });
    this.persist(true);
    this.emitChange();
  }

  checkComplete(file) {
    file.durable = Math.min(file.durable, file.size);
    if (file.durable >= file.size && file.inFlightBytes === 0 && !file.endSent) {
      file.endSent = true;
      this.finishFile(file).catch(error => {
        file.status = "error";
        file.error = error.message || String(error);
        this.emitChange();
      });
    }
  }

  advanceQueue() {
    const finished = this.current;
    if (finished) {
      finished.inflight.clear();
      finished.inFlightBytes = 0;
      if (finished.hasherId) this.hash.dispose(finished.hasherId);
      finished.hasherId = null;
    }
    this.current = null;
    this.persist(true);
    this.emitChange();
    setTimeout(() => this.startQueue(), 0);
  }

  handleMessage(data) {
    if (typeof data !== "string") return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const file = this.files.find(item => item.id === message.fileId);

    if (message.type === "accept") {
      if (!file || file !== this.current) return;
      file.accepted = true;
      file.status = "sending";
      const target = Math.min(Number(message.durable) || 0, file.size);
      this.primeHasher(file, target)
        .then(() => {
          if (!this.connected) this.safeSend({
            type: "file-start",
            fileId: file.id,
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            chunkSize: this.chunkSize
          });
          this.checkComplete(file);
          this.pump();
        });
      this.emitChange();
      return;
    }

    if (message.type === "ack") {
      if (!file || file !== this.current) return;
      const offset = Number(message.offset) || 0;
      for (const [chunkOffset, chunk] of Array.from(file.inflight.entries())) {
        if (chunk.end <= offset) {
          file.inflight.delete(chunkOffset);
          file.inFlightBytes -= chunk.end - chunkOffset;
          file.durable = Math.max(file.durable, chunk.end);
        }
      }
      file.durable = Math.max(file.durable, offset);
      this.persist();
      this.emitChange();

      this.checkComplete(file);
      this.pump();
      return;
    }

    if (message.type === "resync") {
      if (!file || file !== this.current) return;
      const offset = Math.min(Number(message.offset) || 0, file.size);
      file.inflight.clear();
      file.inFlightBytes = 0;
      file.accepted = true;
      file.priming = true;
      if (file.hasherId) this.hash.dispose(file.hasherId);
      file.hasherId = null;
      const generation = (file.primeGeneration || 0) + 1;
      this.emitLog(`校验到偏移 ${offset} 需要重发：${message.reason || "块哈希不一致"}`);
      this.primeHasher(file, offset, true).then(() => {
        if (file.primeGeneration === generation) this.pump();
      });
      return;
    }

    if (message.type === "complete") {
      if (!file || file !== this.current) return;
      if (message.ok) {
        file.status = "done";
        file.durable = file.size;
        file.fullHash = message.fullHash || file.fullHash;
        file.error = "";
        this.emitLog(`${file.name} 完成，SHA-256：${file.fullHash}`);
      } else {
        file.status = "error";
        file.error = message.error || "接收端最终哈希不一致";
        this.emitLog(`${file.name} 失败：${file.error}`);
      }
      this.advanceQueue();
      return;
    }

    if (message.type === "reject" && file && file === this.current) {
      file.status = "error";
      file.error = message.error || "接收端拒绝文件";
      this.current = null;
      this.persist(true);
      this.emitChange();
    }
  }

  retry(id) {
    const file = this.files.find(item => item.id === id);
    if (!file || !file.file) return;
    if (file === this.current) this.current = null;
    file.status = "queued";
    file.error = "";
    file.endSent = false;
    this.persist(true);
    this.emitChange();
    this.startQueue();
  }

  emitChange() {
    this.dispatchEvent(new CustomEvent("change"));
  }

  emitLog(message) {
    this.dispatchEvent(new CustomEvent("log", { detail: { message } }));
  }

  stats() {
    return this.files.map(file => ({
      ...file,
      progress: file.size ? (file.durable / file.size) * 100 : 100,
      buffered: this.current === file ? this.connection.bufferedAmount : 0
    }));
  }
}

self.SenderManager = SenderManager;
