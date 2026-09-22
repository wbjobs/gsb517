import { IncrementalSha256 } from "./utils.js";

let activeGeneration = 0;
let active = null;

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "start") await startFile(message);
    if (message.type === "resume") await resumeFile(message);
    if (message.type === "fill") fill(message.credits);
    if (message.type === "pause") pause();
    if (message.type === "cancel") cancel();
  } catch (error) {
    self.postMessage({ type: "error", fileId: active?.fileId, message: error?.message || String(error) });
  }
};

function cancel() {
  activeGeneration += 1;
  active = null;
}

function pause() {
  if (active) {
    active.paused = true;
    active.credits = 0;
  }
}

function fill(credits) {
  if (!active || active.paused || active.done) return;
  active.credits += Math.max(0, Number(credits) || 0);
  if (!active.running) {
    active.running = true;
    produce().finally(() => {
      if (active) active.running = false;
    });
  }
}

async function startFile(message) {
  const generation = ++activeGeneration;
  const { file, fileId, chunkSize, startIndex, startOffset } = message;
  const totalChunks = Math.ceil(file.size / chunkSize);
  active = {
    generation,
    file,
    fileId,
    chunkSize,
    index: startIndex,
    offset: startOffset,
    totalChunks,
    credits: 0,
    paused: false,
    done: false,
    running: false,
    hasher: new IncrementalSha256(),
  };
  self.postMessage({ type: "preparing", fileId, startIndex, startOffset });
  let verifiedOffset = 0;
  while (verifiedOffset < startOffset && generation === activeGeneration) {
    const end = Math.min(verifiedOffset + chunkSize, startOffset, file.size);
    const prefix = new Uint8Array(await readSlice(file, verifiedOffset, end));
    if (generation !== activeGeneration || !active) return;
    active.hasher.update(prefix);
    verifiedOffset = end;
  }
  if (generation !== activeGeneration || !active) return;
  self.postMessage({ type: "ready", fileId, index: active.index, offset: active.offset });
  if (file.size === 0) {
    active.done = true;
    const fullHash = await active.hasher.digest();
    active.fullHash = fullHash;
    self.postMessage({
      type: "chunk",
      fileId,
      chunk: { index: 0, offset: 0, length: 0, payload: new ArrayBuffer(0), chunkHash: await crypto.subtle.digest("SHA-256", new ArrayBuffer(0)), fullHash, final: true, zeroFile: true },
    });
  }
}

async function resumeFile(message) {
  await startFile(message);
}

async function produce() {
  const state = active;
  if (!state) return;
  while (state === active && state.generation === activeGeneration && !state.paused && !state.done && state.credits > 0 && state.offset < state.file.size) {
    state.credits -= 1;
    const end = Math.min(state.offset + state.chunkSize, state.file.size);
    const payload = await readSlice(state.file, state.offset, end);
    if (state !== active || state.generation !== activeGeneration) return;
    const bytes = new Uint8Array(payload);
    state.hasher.update(bytes);
    const chunkHash = await crypto.subtle.digest("SHA-256", payload);
    if (state !== active || state.generation !== activeGeneration || state.paused) return;
    const chunk = {
      index: state.index,
      offset: state.offset,
      length: payload.byteLength,
      payload,
      chunkHash,
    };
    state.index += 1;
    state.offset = end;
    if (end >= state.file.size) {
      state.done = true;
      const fullHash = await state.hasher.digest();
      if (state !== active || state.generation !== activeGeneration) return;
      chunk.fullHash = fullHash;
      chunk.final = true;
    }
    self.postMessage({ type: "chunk", fileId: state.fileId, chunk }, chunk.payload.byteLength ? [payload, chunkHash, ...(chunk.fullHash ? [chunk.fullHash] : [])] : []);
  }
}

function readSlice(file, start, end) {
  return file.slice(start, end).arrayBuffer();
}
