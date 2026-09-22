importScripts("./sha256.js");

"use strict";

const hashers = new Map();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, "0")).join("");
}

async function handle(message) {
  const { id, type } = message;

  if (type === "create") {
    hashers.set(id, self.createSha256());
    return { type: "created", id };
  }

  const hasher = hashers.get(id);
  if (!hasher) throw new Error(`unknown hasher: ${id}`);

  if (type === "update" || type === "prime") {
    const bytes = new Uint8Array(message.buffer);
    hasher.update(bytes);
    if (type === "update") {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return {
        type: "updated",
        id,
        offset: message.offset,
        chunkHash: toHex(digest),
        buffer: message.buffer
      };
    }
    return { type: "primed", id, offset: message.offset };
  }

  if (type === "finish") {
    const fullHash = hasher.hex();
    hashers.delete(id);
    return { type: "finished", id, fullHash };
  }

  if (type === "dispose") {
    hashers.delete(id);
    return { type: "disposed", id };
  }

  throw new Error(`unknown hash worker message: ${type}`);
}

self.onmessage = event => {
  Promise.resolve()
    .then(() => handle(event.data))
    .then(response => {
      const transfer = response.buffer ? [response.buffer] : [];
      self.postMessage(response, transfer);
    })
    .catch(error => {
      self.postMessage({
        type: "error",
        id: event.data && event.data.id,
        error: String(error && error.message || error)
      });
    });
};
