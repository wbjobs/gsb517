import { createId, formatBytes } from "./utils.js";

export const receiverStates = new Map();

export function createSenderEntry(file, chunkSize) {
  return {
    key: "",
    role: "sender",
    file,
    fileId: "",
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    chunkSize,
    manualPause: false,
    status: "queued",
    bytesSent: 0,
    bytesAcked: 0,
    expectedIndex: 0,
    speed: 0,
    buffered: 0,
    hashText: "待发送",
    error: "",
  };
}

export function createReceiverEntry(metadata) {
  return {
    role: "receiver",
    file: null,
    fileId: metadata.fileId,
    name: metadata.name,
    size: metadata.size,
    lastModified: metadata.lastModified,
    chunkSize: metadata.chunkSize,
    status: metadata.status === "complete" ? "complete" : "paused",
    bytesSent: metadata.offset,
    bytesAcked: metadata.offset,
    expectedIndex: metadata.index,
    speed: 0,
    buffered: 0,
    hashText: metadata.fullHash ? `SHA-256 ${metadata.fullHash}` : "等待发送方续传",
    error: "",
    receivedAt: metadata.updatedAt || metadata.createdAt,
    metadata,
  };
}

export async function fileIdFor(file) {
  const basis = new TextEncoder().encode(`${file.name}\0${file.size}\0${file.lastModified}`);
  const hash = await crypto.subtle.digest("SHA-256", basis);
  return `f${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`.slice(0, 32);
}

export function shortId() {
  return createId("s").slice(2, 34).replace("_", "");
}

export async function scanReceivedFiles() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (!name.endsWith(".state") || handle.kind !== "file") continue;
      const file = await handle.getFile();
      try {
        const metadata = JSON.parse(await file.text());
        if (metadata?.fileId) {
          await root.getFileHandle(metadata.fileId);
          receiverStates.set(metadata.fileId, metadata);
        }
      } catch {
        // Ignore corrupted state rows; active transfer can recreate them.
      }
    }
  } catch (error) {
    console.warn("OPFS scan failed", error);
  }
}

export async function storageSummary() {
  if (!navigator.storage?.estimate) return "";
  const estimate = await navigator.storage.estimate();
  const quota = estimate.quota || 0;
  const usage = estimate.usage || 0;
  return quota ? `OPFS：${formatBytes(usage)} / ${formatBytes(quota)}` : `OPFS：${formatBytes(usage)}`;
}
