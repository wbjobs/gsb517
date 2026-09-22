(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.createSha256 = factory;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function createSha256() {
    const h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    const w = new Uint32Array(64);
    const buffer = new Uint8Array(64);
    let buffered = 0;
    let bytes = 0;
    let finished = false;

    function block(chunk, offset) {
      for (let i = 0; i < 16; i += 1) {
        w[i] = (chunk[offset + i * 4] << 24)
          | (chunk[offset + i * 4 + 1] << 16)
          | (chunk[offset + i * 4 + 2] << 8)
          | chunk[offset + i * 4 + 3];
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      let a = h[0], b = h[1], c = h[2], d = h[3];
      let e = h[4], f = h[5], g = h[6], i = h[7];

      for (let j = 0; j < 64; j += 1) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (i + s1 + ch + K[j] + w[j]) | 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) | 0;
        i = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }

      h[0] = (h[0] + a) | 0;
      h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0;
      h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0;
      h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0;
      h[7] = (h[7] + i) | 0;
    }

    function update(data) {
      if (finished) throw new Error("hasher already finished");
      const input = data instanceof Uint8Array ? data : new Uint8Array(data);
      let position = 0;
      bytes += input.length;

      if (buffered > 0) {
        while (position < input.length && buffered < 64) {
          buffer[buffered] = input[position];
          buffered += 1;
          position += 1;
        }
        if (buffered === 64) {
          block(buffer, 0);
          buffered = 0;
        }
      }

      while (position + 64 <= input.length) {
        block(input, position);
        position += 64;
      }

      while (position < input.length) {
        buffer[buffered] = input[position];
        buffered += 1;
        position += 1;
      }
      return this;
    }

    function digest() {
      if (finished) throw new Error("hasher already finished");
      finished = true;
      const totalBytes = bytes;
      const totalBitsHigh = Math.floor(totalBytes / 0x20000000);
      const totalBitsLow = (totalBytes & 0x1fffffff) * 8;

      buffer[buffered] = 0x80;
      buffered += 1;
      if (buffered > 56) {
        while (buffered < 64) {
          buffer[buffered] = 0;
          buffered += 1;
        }
        block(buffer, 0);
        buffered = 0;
      }
      while (buffered < 56) {
        buffer[buffered] = 0;
        buffered += 1;
      }
      buffer[56] = (totalBitsHigh >>> 24) & 0xff;
      buffer[57] = (totalBitsHigh >>> 16) & 0xff;
      buffer[58] = (totalBitsHigh >>> 8) & 0xff;
      buffer[59] = totalBitsHigh & 0xff;
      buffer[60] = (totalBitsLow >>> 24) & 0xff;
      buffer[61] = (totalBitsLow >>> 16) & 0xff;
      buffer[62] = (totalBitsLow >>> 8) & 0xff;
      buffer[63] = totalBitsLow & 0xff;
      block(buffer, 0);

      const output = new Uint8Array(32);
      for (let i = 0; i < 8; i += 1) {
        output[i * 4] = (h[i] >>> 24) & 0xff;
        output[i * 4 + 1] = (h[i] >>> 16) & 0xff;
        output[i * 4 + 2] = (h[i] >>> 8) & 0xff;
        output[i * 4 + 3] = h[i] & 0xff;
      }
      return output;
    }

    function hex() {
      return Array.from(digest(), value => value.toString(16).padStart(2, "0")).join("");
    }

    return { update, digest, hex };
  }

  createSha256.bytes = function (data) {
    return createSha256().update(data).digest();
  };

  createSha256.hex = function (data) {
    return createSha256().update(data).hex();
  };

  return createSha256;
});
