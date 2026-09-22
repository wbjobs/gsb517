export const HEADER_MAGIC = 0x57465443;
export const HEADER_VERSION = 1;
export const HEADER_BYTES = 176;

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 100 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function createId(prefix) {
  const random = crypto.getRandomValues(new Uint8Array(8));
  random[0] |= 0x80;
  random[1] &= 0x3f;
  return `${prefix}_${Date.now().toString(36)}_${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function postJson(channel, type, payload = {}) {
  if (channel && channel.readyState === RTCDataChannel.OPEN) {
    channel.send(JSON.stringify({ type, ...payload }));
    return true;
  }
  return false;
}

export function encodeHeader({ streamId, fileId, index, offset, payloadLength, ackIndex, chunkHash, generation = 0 }) {
  const encoder = new TextEncoder();
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, HEADER_MAGIC, false);
  view.setUint16(4, HEADER_VERSION, false);
  view.setUint16(6, generation, false);
  view.setBigUint64(8, BigInt(index), false);
  view.setBigUint64(16, BigInt(offset), false);
  view.setUint32(24, ackIndex ?? 0, false);
  view.setUint32(28, payloadLength, false);
  const streamBytes = encoder.encode(streamId.slice(0, 32).padEnd(32, " "));
  bytes.set(streamBytes, 40);
  const fileBytes = encoder.encode(fileId.slice(0, 32).padEnd(32, " "));
  bytes.set(fileBytes, 72);
  if (chunkHash) bytes.set(new Uint8Array(chunkHash), 144);
  return buffer;
}

export function decodeHeader(buffer) {
  if (buffer.byteLength !== HEADER_BYTES) return null;
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (view.getUint32(0, false) !== HEADER_MAGIC || view.getUint16(4, false) !== HEADER_VERSION) return null;
  const decoder = new TextDecoder();
  return {
    payloadLength: view.getUint32(28, false),
    index: Number(view.getBigUint64(8, false)),
    offset: Number(view.getBigUint64(16, false)),
    ackIndex: view.getUint32(24, false),
    streamId: decoder.decode(bytes.subarray(40, 72)).trim(),
    fileId: decoder.decode(bytes.subarray(72, 104)).trim(),
    chunkHash: bytes.subarray(144, 176).slice().buffer,
    generation: view.getUint16(6, false),
  };
}

export function sha256Hex(buffer) {
  return crypto.subtle.digest("SHA-256", buffer).then((hash) => Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c,  0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export class IncrementalSha256 {
  constructor(state) {
    this.words = new Uint32Array(state?.words ?? [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.bytesWritten = state?.bytesWritten ?? 0;
    this.buffer = new Uint8Array(64);
    this.bufferLength = state?.bufferLength ?? 0;
    if (state?.buffer) this.buffer.set(new Uint8Array(state.buffer));
  }

  update(input) {
    const data = new Uint8Array(input);
    let offset = 0;
    if (this.bufferLength > 0) {
      const needed = Math.min(64 - this.bufferLength, data.length);
      this.buffer.set(data.subarray(0, needed), this.bufferLength);
      this.bufferLength += needed;
      offset += needed;
      if (this.bufferLength === 64) {
        this.block(this.buffer);
        this.bufferLength = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.block(data.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), this.bufferLength);
      this.bufferLength += data.length - offset;
    }
    this.bytesWritten += data.length;
    return this;
  }

  block(block) {
    const w = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const w15 = w[index - 15];
      const w2 = w[index - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.words;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA_K[index] + w[index]) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const values = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) this.words[index] = (this.words[index] + values[index]) >>> 0;
  }

  toState() {
    return {
      words: Array.from(this.words),
      bytesWritten: this.bytesWritten,
      bufferLength: this.bufferLength,
      buffer: this.buffer.slice(0, this.bufferLength).buffer,
    };
  }

  async digest() {
    const clone = new IncrementalSha256(this.toState());
    const bitLength = BigInt(clone.bytesWritten) * 8n;
    clone.buffer[clone.bufferLength] = 0x80;
    clone.bufferLength += 1;
    if (clone.bufferLength > 56) {
      clone.buffer.fill(0, clone.bufferLength);
      clone.block(clone.buffer);
      clone.bufferLength = 0;
    }
    clone.buffer.fill(0, clone.bufferLength, 56);
    new DataView(clone.buffer.buffer).setBigUint64(56, bitLength, false);
    clone.block(clone.buffer);
    const output = new ArrayBuffer(32);
    const outputView = new DataView(output);
    for (let index = 0; index < 8; index += 1) outputView.setUint32(index * 4, clone.words[index], false);
    return output;
  }
}
