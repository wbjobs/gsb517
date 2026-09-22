"use strict";

class HashClient {
  constructor(scriptUrl = "js/hash-worker.js") {
    this.worker = new Worker(new URL(scriptUrl, document.baseURI), { type: "classic" });
    this.nextId = 1;
    this.pending = new Map();
    this.worker.onmessage = event => {
      const message = event.data;
      const item = this.pending.get(message.id);
      if (item) {
        this.pending.delete(message.id);
        if (message.type === "error") item.reject(new Error(message.error));
        else item.resolve(message);
      }
    };
    this.worker.onerror = error => {
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
    };
  }

  call(message, transfer = []) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }

  create() {
    return this.call({ type: "create" });
  }

  update(id, offset, buffer) {
    return this.call({ type: "update", id, offset, buffer }, [buffer]);
  }

  prime(id, offset, buffer) {
    return this.call({ type: "prime", id, offset, buffer }, [buffer]);
  }

  finish(id) {
    return this.call({ type: "finish", id });
  }

  dispose(id) {
    return this.call({ type: "dispose", id }).catch(() => {});
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}

self.HashClient = HashClient;
