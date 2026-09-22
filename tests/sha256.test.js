const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const createSha256 = require("../js/sha256.js");

test("matches node crypto across chunk boundaries", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 4095, 100000]) {
    const data = crypto.randomBytes(size);
    const expected = crypto.createHash("sha256").update(data).digest("hex");
    const hasher = createSha256();
    for (let offset = 0; offset < data.length; offset += 37) {
      hasher.update(data.subarray(offset, Math.min(offset + 37, data.length)));
    }
    assert.equal(hasher.hex(), expected, `size ${size}`);
  }
});
