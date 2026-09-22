"use strict";

class ReceiverManager extends EventTarget {
  constructor(connection) {
    super();
    this.connection = connection;
    this.hash = new HashClient();
    this.directory = null;
    this.directoryName = "";
    this.files = new Map();
    this.order = [];
    this.connected = false;
    this.lastSave = 0;
    this.expected = null;
    this.load();

    connection.addEventListener("dataopen", () => {
      this.connected = true;
      this.safeSend({ type: "hello", protocol: 1, role: "receiver" });
      for (const file of this.files.values()) {
        if (file.status !== "done" && file.durable < file.size) {
          file.nextOffset = file.durable;
          file.status = "waiting";
          this.resendAccept(file);
        }
      }
      this.emitChange();
    });
    connection.addEventListener("dataclosed", () => {
      this.connected = false;
      this.expected = null;
      for (const file of this.files.values()) {
        if (file.status === "receiving") file.status = "waiting";
      }
      this.emitChange();
    });
    connection.addEventListener("datamessage", event => this.handleData(event.detail.data));
  }

  static supported() {
    return Boolean(window.showDirectoryPicker &&
      window.FileSystemFileHandle &&
      "createWritable" in FileSystemFileHandle.prototype);
  }

  load() {
    const data = appUtils.loadJson(appUtils.RECEIVER_KEY, {
      files: [],
      directoryHandleKey: ""
    });
    for (const file of data.files) {
      this.files.set(file.id, {
        ...file,
        writable: null,
        handle: null,
        partHandle: null,
        hasherId: null,
        busy: null,
        tail: Promise.resolve(),
        nextOffset: file.durable || 0,
        acceptTimer: null
      });
      this.order.push(file.id);
    }
    this.directoryHandleKey = data.directoryHandleKey || "";
  }

  async restoreDirectoryHandle() {
    if (!this.directoryHandleKey) return false;
    const handle = await appIdb.idbGet(this.directoryHandleKey);
    if (!handle) return false;
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") return false;
    this.directory = handle;
    this.directoryName = handle.name;
    this.emitChange();
    return true;
  }

  async chooseDirectory() {
    if (!ReceiverManager.supported()) {
      throw new Error("此浏览器不支持 File System Access API，请使用 Chrome/Edge，并通过 HTTPS 或 localhost 打开。");
    }
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("未授予目录写入权限");
    this.directory = handle;
    this.directoryName = handle.name;
    this.directoryHandleKey = `receiver-directory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await appIdb.idbPut(this.directoryHandleKey, handle);
    this.persist(true);
    this.emitChange();
  }

  persist(force = false) {
    const now = Date.now();
    if (!force && now - this.lastSave < 500) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.persist(true), 500);
      return;
    }
    this.lastSave = now;
    const files = this.order.map(id => {
      const file = this.files.get(id);
      return {
        id: file.id,
        name: file.name,
        savedName: file.savedName,
        partName: file.partName,
        size: file.size,
        durable: file.durable,
        status: file.status,
        fullHash: file.fullHash,
        error: file.error || ""
      };
    });
    appUtils.saveJson(appUtils.RECEIVER_KEY, {
      files,
      directoryHandleKey: this.directoryHandleKey || ""
    });
  }

  async ensureStorage(file) {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      const needed = file.size - file.durable;
      if (typeof estimate.quota === "number" && estimate.quota - (estimate.usage || 0) < needed) {
        throw new Error("浏览器存储配额不足，请释放磁盘空间或更换下载目录");
      }
    }
  }

  enqueue(file, task) {
    const run = file.tail.then(task, task);
    file.tail = run.catch(() => {});
    return run;
  }

  handleKey(fileId, suffix) {
    return `receiver:${fileId}:${suffix}`;
  }

  safeSend(message) {
    try {
      this.connection.sendJson(message);
    } catch (error) {
      this.emitLog(`发送控制消息失败：${error.message}`);
    }
  }

  resendAccept(file) {
    clearInterval(file.acceptTimer);
    let attempts = 0;
    file.acceptTimer = setInterval(() => {
      attempts += 1;
      if (!this.connected || file.status === "done" || file.durable >= file.size) {
        clearInterval(file.acceptTimer);
        file.acceptTimer = null;
        return;
      }
      this.safeSend({ type: "accept", fileId: file.id, durable: file.durable });
      if (attempts >= 10) {
        clearInterval(file.acceptTimer);
        file.acceptTimer = null;
      }
    }, 150);
    this.safeSend({ type: "accept", fileId: file.id, durable: file.durable });
  }

  async openWritable(file) {
    if (file.writable) return;
    if (!this.directory) throw new Error("请先选择接收目录");
    file.durable = Math.min(file.durable, file.size);

    let partHandle;
    const partKey = this.handleKey(file.id, "part");
    const shouldPrimeFromDisk = file.durable > 0 && !file.hasherId;
    if (shouldPrimeFromDisk) partHandle = await appIdb.idbGet(partKey);

    if (!partHandle) {
      const existing = new Set(await this.directory.keys());
      file.name = appUtils.uniqueName(existing, file.requestedName);
      file.partName = appUtils.partName(file.name);
      if (existing.has(file.partName.toLowerCase())) {
        file.partName = appUtils.uniqueName(existing, file.partName);
        file.name = file.partName.replace(/\.webrtc-part$/, "");
      }
      partHandle = await this.directory.getFileHandle(file.partName, { create: true });
      await appIdb.idbPut(partKey, partHandle);
    }

    file.partHandle = partHandle;
    file.writable = await partHandle.createWritable({ keepExistingData: true });
    file.nextOffset = file.durable;

    if (shouldPrimeFromDisk) {
      const diskFile = await partHandle.getFile();
      if (diskFile.size < file.durable) {
        file.durable = diskFile.size;
      }
      const hasher = await this.hash.create();
      file.hasherId = hasher.id;
      let offset = 0;
      const sliceSize = 64 * 1024;
      while (offset < file.durable) {
        const end = Math.min(offset + sliceSize, file.durable);
        const buffer = await diskFile.slice(offset, end).arrayBuffer();
        await this.hash.prime(file.hasherId, offset, buffer);
        offset = end;
      }
    } else if (!file.hasherId) {
      const hasher = await this.hash.create();
      file.hasherId = hasher.id;
    }
    await file.writable.seek(file.durable);
  }

  async resetHasher(file, offset) {
    if (file.hasherId) await this.hash.dispose(file.hasherId);
    const hasher = await this.hash.create();
    file.hasherId = hasher.id;
    const diskFile = file.partHandle ? await file.partHandle.getFile() : null;
    if (!diskFile) return;

    let position = 0;
    const sliceSize = 64 * 1024;
    while (position < offset && position < diskFile.size) {
      const end = Math.min(position + sliceSize, offset, diskFile.size);
      const buffer = await diskFile.slice(position, end).arrayBuffer();
      await this.hash.prime(file.hasherId, position, buffer);
      position = end;
    }
  }

  async handleString(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (message.type === "file-start") {
      await this.startFile(message);
      return;
    }

    const file = this.files.get(message.fileId);
    if (!file) return;

    if (message.type === "chunk") {
      this.expected = { fileId: file.id, offset: message.offset, end: message.end, hash: message.hash };
    }

    if (message.type === "file-end") {
      await this.enqueue(file, () => this.finishFile(file, message.fullHash));
    }
  }

  async startFile(message) {
    let file = this.files.get(message.fileId);
    if (file) {
      file.requestedName = message.name;
      file.size = message.size;
      file.status = this.connected ? "receiving" : "waiting";
      file.error = "";
    } else {
      file = {
        id: message.fileId,
        requestedName: message.name,
        name: message.name,
        savedName: "",
        partName: "",
        size: message.size,
        durable: 0,
        status: this.connected ? "receiving" : "waiting",
        fullHash: "",
        error: "",
        writable: null,
        handle: null,
        partHandle: null,
        hasherId: null,
        busy: null,
        tail: Promise.resolve(),
        nextOffset: 0,
        acceptTimer: null
      };
      this.files.set(file.id, file);
      this.order.push(file.id);
    }
    this.emitChange();

    try {
      if (!this.directory) {
        file.status = "needs_directory";
        file.error = "接收端尚未选择目录";
        this.safeSend({ type: "reject", fileId: file.id, error: file.error });
        this.persist(true);
        this.emitChange();
        return;
      }
      await this.enqueue(file, async () => {
        await this.ensureStorage(file);
        await this.openWritable(file);
        file.nextOffset = file.durable;
        file.status = "receiving";
        file.error = "";
        this.safeSend({ type: "accept", fileId: file.id, durable: file.durable });
        this.persist(true);
        this.emitChange();
      });
    } catch (error) {
      file.status = "error";
      file.error = error.message || String(error);
      this.safeSend({ type: "reject", fileId: file.id, error: file.error });
      this.persist(true);
      this.emitChange();
    }
  }

  async handleBinary(buffer) {
    const expected = this.expected;
    this.expected = null;
    if (!expected) {
      this.emitLog("收到无文件头的二进制块，已丢弃");
      return;
    }
    const file = this.files.get(expected.fileId);
    if (!file) return;

    await this.enqueue(file, async () => {
      try {
        if (expected.offset !== file.nextOffset) return;
        if (file.status === "waiting") file.status = "receiving";
        if (!file.writable) await this.openWritable(file);

        const result = await this.hash.update(file.hasherId, expected.offset, buffer);
        if (result.chunkHash !== expected.hash) {
          await this.resetHasher(file, expected.offset);
          this.safeSend({
            type: "resync",
            fileId: file.id,
            offset: expected.offset,
            reason: `块 ${expected.offset}-${expected.end} SHA-256 不一致`
          });
          this.emitLog(`块哈希不一致，从 ${expected.offset} 重发`);
          return;
        }
        await file.writable.seek(expected.offset);
        await file.writable.write(result.buffer);
        const nextOffset = expected.end;
        if (nextOffset > file.durable) file.durable = nextOffset;
        file.nextOffset = expected.end;

        const crossesMegabyte = Math.floor(file.durable / (1024 * 1024)) !==
          Math.floor(expected.offset / (1024 * 1024));
        if (crossesMegabyte || file.durable >= file.size) {
          await file.writable.flush();
        }
        this.safeSend({ type: "ack", fileId: file.id, offset: file.durable });
        this.persist(file.durable >= file.size);
        this.emitChange();
      } catch (error) {
        file.status = "error";
        file.error = error.message || String(error);
        this.persist(true);
        this.emitChange();
        this.emitLog(`写入失败：${file.error}`);
      }
    });
  }

  async finishFile(file, remoteHash) {
    try {
      file.status = "verifying";
      this.emitChange();
      const result = await this.hash.finish(file.hasherId);
      file.hasherId = null;
      file.fullHash = result.fullHash;
      if (file.fullHash !== remoteHash) {
        throw new Error(`最终 SHA-256 不一致：本地 ${file.fullHash}，对端 ${remoteHash}`);
      }

      await file.writable.flush();
      await file.writable.close();
      file.writable = null;

      if (typeof file.partHandle.move === "function") {
        await file.partHandle.move(file.name);
      } else {
        const finalHandle = await this.directory.getFileHandle(file.name, { create: true });
        const sink = await finalHandle.createWritable();
        const partFile = await file.partHandle.getFile();
        await sink.write(partFile);
        await sink.close();
        await this.directory.removeEntry(file.partName);
      }

      file.savedName = file.name;
      file.status = "done";
      file.error = "";
      await appIdb.idbDelete(this.handleKey(file.id, "part"));
      this.safeSend({ type: "complete", fileId: file.id, ok: true, fullHash: file.fullHash });
      this.persist(true);
      this.emitLog(`${file.name} 已保存并通过 SHA-256 校验`);
      this.emitChange();
    } catch (error) {
      file.status = "error";
      file.error = error.message || String(error);
      this.safeSend({ type: "complete", fileId: file.id, ok: false, error: file.error });
      this.persist(true);
      this.emitChange();
      this.emitLog(file.error);
    }
  }

  handleData(data) {
    if (typeof data === "string") {
      this.handleString(data).catch(error => this.emitLog(error.message || String(error)));
    } else if (data instanceof ArrayBuffer) {
      this.handleBinary(data).catch(error => this.emitLog(error.message || String(error)));
    }
  }

  clearFinished() {
    for (const id of this.order.filter(itemId => this.files.get(itemId)?.status === "done")) {
      this.files.delete(id);
    }
    this.order = this.order.filter(id => this.files.has(id));
    this.persist(true);
    this.emitChange();
  }

  stats() {
    return this.order.map(id => {
      const file = this.files.get(id);
      return {
        ...file,
        progress: file.size ? (file.durable / file.size) * 100 : 0
      };
    });
  }

  emitChange() {
    this.dispatchEvent(new CustomEvent("change"));
  }

  emitLog(message) {
    this.dispatchEvent(new CustomEvent("log", { detail: { message } }));
  }
}

self.ReceiverManager = ReceiverManager;
