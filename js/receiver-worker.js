import { IncrementalSha256 } from "./utils.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sessions = new Map();

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "prepare") await prepare(message);
    if (message.type === "chunk") await receiveChunk(message);
    if (message.type === "finalize") await finalize(message);
    if (message.type === "remove") await remove(message.fileId);
  } catch (error) {
    self.postMessage({
      type: "error",
      fileId: message.fileId,
      chunkIndex: message.chunk?.index,
      message: error?.message || String(error),
    });
  }
};

async function prepare(message) {
  const { fileId, name, size, chunkSize, lastModified, streamId } = message;
  const current = sessions.get(fileId);
  if (current && current.transfer.name === name && current.transfer.size === size && current.transfer.chunkSize === chunkSize) {
    current.transfer.streamId = streamId;
    self.postMessage({
      type: "ready",
      fileId,
      resumeIndex: current.transfer.index,
      resumeOffset: current.transfer.offset,
      saved: current.transfer.offset > 0,
    });
    return;
  }
  await closeSession(fileId);
  const root = await navigator.storage.getDirectory();
  const dataHandle = await root.getFileHandle(fileId, { create: true });
  const stateName = stateFile(fileId);
  const stateHandle = await root.getFileHandle(stateName, { create: true });
  const data = await dataHandle.createSyncAccessHandle();
  const state = await stateHandle.createSyncAccessHandle();
  const saved = await readState(state);
  let transfer = saved && saved.fileId === fileId && saved.name === name && saved.size === size && saved.chunkSize === chunkSize
    ? saved
    : null;
  if (!transfer) {
    data.truncate(size);
    transfer = {
      fileId,
      streamId,
      name,
      size,
      chunkSize,
      lastModified,
      index: 0,
      offset: 0,
      hashState: null,
      status: "receiving",
      createdAt: Date.now(),
    };
  }

  const dataSize = data.getSize();
  if (transfer.offset > size || dataSize < transfer.offset) {
    transfer.index = 0;
    transfer.offset = 0;
    transfer.hashState = null;
    data.truncate(size);
  }
  const hasher = new IncrementalSha256(transfer.hashState);
  const session = { data, state, transfer, hasher };
  sessions.set(fileId, session);
  await persist(session);

  self.postMessage({
    type: "ready",
    fileId,
    resumeIndex: transfer.index,
    resumeOffset: transfer.offset,
    saved: Boolean(saved),
  });
}

async function receiveChunk(message) {
  const { fileId, chunk } = message;
  const session = sessions.get(fileId);
  if (!session) throw new Error(`尚未初始化接收文件：${fileId}`);
  const { transfer, data, state, hasher } = session;
  if (message.streamId && transfer.streamId && message.streamId !== transfer.streamId) return;
  if (transfer.status !== "receiving") throw new Error("文件已经完成，不能继续写入");
  if (chunk.index !== transfer.index || chunk.offset !== transfer.offset) {
    self.postMessage({
      type: "resync",
      fileId,
      resumeIndex: transfer.index,
      resumeOffset: transfer.offset,
      reason: "收到过期或乱序分块，请求从确认点续传",
    });
    return;
  }

  const expectedHash = new Uint8Array(chunk.chunkHash);
  const actualHash = new Uint8Array(await crypto.subtle.digest("SHA-256", chunk.payload));
  if (expectedHash.length !== actualHash.length || expectedHash.some((byte, index) => byte !== actualHash[index])) {
    throw new Error(`第 ${transfer.index + 1} 块哈希不一致，已阻止写入`);
  }

  const payload = new Uint8Array(chunk.payload);
  data.write(payload, { at: transfer.offset });
  hasher.update(payload);
  transfer.index += 1;
  transfer.offset += payload.byteLength;
  if (transfer.offset > transfer.size) {
    transfer.offset -= payload.byteLength;
    transfer.index -= 1;
    throw new Error("发送数据超过声明文件大小");
  }

  const shouldFlush = transfer.index % 8 === 0 || transfer.offset === transfer.size || chunk.final;
  if (shouldFlush) {
    transfer.hashState = hasher.toState();
    transfer.updatedAt = Date.now();
    await persist(session);
    data.flush();
  }

  self.postMessage({
    type: "ack",
    fileId,
    ackIndex: transfer.index - 1,
    bytesWritten: transfer.offset,
    final: Boolean(chunk.final),
  });
}

async function finalize(message) {
  if (!sessions.has(message.fileId) && message.zero) {
    await prepare({
      fileId: message.fileId,
      name: message.name || message.fileId,
      size: 0,
      chunkSize: 32768,
      lastModified: Date.now(),
      streamId: message.streamId || "",
    });
  }
  const session = sessions.get(message.fileId);
  if (!session) throw new Error("找不到接收会话");
  if (message.streamId && session.transfer.streamId && message.streamId !== session.transfer.streamId) return;
  const { transfer, hasher } = session;
  if (transfer.offset !== transfer.size) throw new Error(`文件不完整：${transfer.offset}/${transfer.size}`);
  const actual = new Uint8Array(await hasher.digest());
  const expected = new Uint8Array(message.fullHash);
  if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) {
    throw new Error("整文件 SHA-256 不一致，已保留断点以便重传");
  }
  transfer.status = "complete";
  transfer.fullHash = Array.from(expected, (byte) => byte.toString(16).padStart(2, "0")).join("");
  transfer.completedAt = Date.now();
  transfer.hashState = hasher.toState();
  await persist(session);
  session.data.flush();
  await closeSession(message.fileId);
  self.postMessage({ type: "complete", fileId: message.fileId, fullHash: transfer.fullHash });
}

async function remove(fileId) {
  await closeSession(fileId);
  const root = await navigator.storage.getDirectory();
  for (const name of [fileId, stateFile(fileId)]) {
    try { await root.removeEntry(name); } catch (error) { if (error?.name !== "NotFoundError") throw error; }
  }
  self.postMessage({ type: "removed", fileId });
}

async function closeSession(fileId) {
  const session = sessions.get(fileId);
  if (!session) return;
  await session.data.close();
  await session.state.close();
  sessions.delete(fileId);
}

async function readState(handle) {
  const size = handle.getSize();
  if (!size) return null;
  const buffer = new ArrayBuffer(size);
  const read = handle.read(buffer);
  if (read !== size) return null;
  try { return JSON.parse(decoder.decode(buffer)); } catch { return null; }
}

async function persist(session) {
  const bytes = encoder.encode(JSON.stringify(session.transfer));
  session.state.setSize(0);
  session.state.write(bytes, { at: 0 });
  session.state.flush();
}

function stateFile(fileId) {
  return `${fileId}.state`;
}
