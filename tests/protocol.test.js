const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

global.self = globalThis;
global.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
global.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); }
};
global.navigator = { storage: { estimate: async () => ({ quota: 100 * 1024 * 1024, usage: 0 }) } };

const createSha256 = require("../js/sha256.js");
global.createSha256 = createSha256;
require("../js/utils.js");
global.appIdb = {
  values: new Map(),
  async idbPut(key, value) { this.values.set(key, value); },
  async idbGet(key) { return this.values.get(key); },
  async idbDelete(key) { this.values.delete(key); }
};

class FakeHashClient {
  constructor() {
    this.hashers = new Map();
    this.nextId = 1;
  }
  async create() {
    const id = String(this.nextId++);
    this.hashers.set(id, createSha256());
    return { id };
  }
  async update(id, offset, buffer) {
    const bytes = new Uint8Array(buffer);
    this.hashers.get(id).update(bytes);
    return { id, offset, chunkHash: crypto.createHash("sha256").update(bytes).digest("hex"), buffer };
  }
  async prime(id, offset, buffer) {
    this.hashers.get(id).update(new Uint8Array(buffer));
    return { id, offset };
  }
  async finish(id) {
    const fullHash = this.hashers.get(id).hex();
    this.hashers.delete(id);
    return { id, fullHash };
  }
  async dispose(id) {
    this.hashers.delete(id);
    return { id };
  }
}
global.HashClient = FakeHashClient;

class FakeConnection extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.open = true;
    this.dc = { readyState: "open", maxMessageSize: 65536 };
    this.bufferedAmount = 0;
  }
  send(message) {
    if (!this.open || !this.peer.open) return;
    this.peer.dispatchEvent(new CustomEvent("datamessage", { detail: { data: message } }));
  }
  sendJson(message) {
    this.send(JSON.stringify(message));
  }
  state() {
    return { bufferedAmount: this.bufferedAmount };
  }
}

class FakeFile {
  constructor(name, bytes) {
    this.name = name;
    this.size = bytes.length;
    this.lastModified = 123456789;
    this.type = "";
    this.bytes = bytes;
  }
  slice(start, end) {
    return {
      arrayBuffer: async () => Uint8Array.from(this.bytes.subarray(start, end)).buffer
    };
  }
}

class FakeWritable {
  constructor(handle) {
    this.handle = handle;
    this.position = 0;
    this.chunks = [];
    this.closed = false;
  }
  async seek(position) { this.position = position; }
  async write(data) {
    const bytes = Buffer.from(data);
    this.chunks.push({ position: this.position, bytes });
    this.position += bytes.length;
  }
  async flush() {}
  async close() {
    this.closed = true;
    const total = Math.max(...this.chunks.map(chunk => chunk.position + chunk.bytes.length), 0);
    const output = Buffer.alloc(total);
    for (const chunk of this.chunks) chunk.bytes.copy(output, chunk.position);
    this.handle.bytes = output;
  }
}

class FakeHandle {
  constructor(name, directory) {
    this.name = name;
    this.directory = directory;
    this.bytes = Buffer.alloc(0);
    this.moveCalls = 0;
  }
  async createWritable() {
    return new FakeWritable(this);
  }
  async getFile() {
    return { size: this.bytes.length, slice: (...args) => this.bytes.slice(...args) };
  }
  async move(name) {
    const oldName = this.name;
    this.name = name;
    this.directory.files.set(name, this.directory.files.get(oldName));
    this.directory.files.delete(oldName);
    this.moveCalls += 1;
  }
}

class FakeDirectory {
  constructor() {
    this.name = "downloads";
    this.files = new Map();
  }
  async keys() { return Array.from(this.files.keys()); }
  async getFileHandle(name) {
    if (!this.files.has(name)) this.files.set(name, new FakeHandle(name, this));
    return this.files.get(name);
  }
  async removeEntry(name) { this.files.delete(name); }
}

require("../js/sender.js");
require("../js/receiver.js");
const { SenderManager } = globalThis;
const { ReceiverManager } = globalThis;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for transfer");
    await delay(5);
  }
}

function dispatchOpen(connection) {
  connection.dispatchEvent(new CustomEvent("dataopen", {}));
}

function dispatchClose(connection) {
  connection.open = false;
  connection.dc.readyState = "closed";
  connection.dispatchEvent(new CustomEvent("dataclosed", {}));
}

function dispatchReopen(connection) {
  connection.open = true;
  connection.dc.readyState = "open";
  dispatchOpen(connection);
}

test("streams, reconnects, verifies chunks and final SHA-256", async () => {
  localStorage.values.clear();
  appIdb.values.clear();
  const a = new FakeConnection();
  const b = new FakeConnection();
  a.peer = b;
  b.peer = a;

  const sender = new SenderManager(a);
  const receiver = new ReceiverManager(b);
  receiver.directory = new FakeDirectory();
  let hold = false;
  let corrupted = false;
  let corruptionArmed = false;
  const senderSend = a.send.bind(a);
  a.send = message => {
    if (corruptionArmed && !corrupted && message instanceof ArrayBuffer) {
      new Uint8Array(message)[0] ^= 0xff;
      corrupted = true;
    }
    senderSend(message);
  };
  const receiverSend = b.send.bind(b);
  b.send = message => {
    if (hold && typeof message === "string" && JSON.parse(message).type === "ack") return;
    receiverSend(message);
  };

  hold = true;
  dispatchOpen(b);
  dispatchOpen(a);

  const input = crypto.randomBytes(1024 * 1024 + 123);
  const secondInput = crypto.randomBytes(128 * 1024 + 7);
  await sender.addFiles([
    new FakeFile("resume.bin", input),
    new FakeFile("second.bin", secondInput)
  ]);

  await waitFor(() => receiver.stats()[0] && receiver.stats()[0].durable >= 200 * 1024, 30000);
  dispatchClose(a);
  dispatchClose(b);
  await delay(30);

  hold = false;
  corruptionArmed = true;
  dispatchReopen(b);
  dispatchReopen(a);

  await waitFor(() => sender.files.every(file => file.status === "done"), 20000);
  const received = receiver.stats()[0];
  const secondReceived = receiver.stats()[1];
  assert.equal(received.status, "done");
  assert.equal(secondReceived.status, "done");
  assert.equal(received.fullHash, crypto.createHash("sha256").update(input).digest("hex"));
  assert.equal(secondReceived.fullHash, crypto.createHash("sha256").update(secondInput).digest("hex"));
  const saved = receiver.directory.files.get("resume.bin");
  const secondSaved = receiver.directory.files.get("second.bin");
  assert.ok(saved);
  assert.ok(secondSaved);
  assert.equal(saved.bytes.length, input.length);
  assert.equal(secondSaved.bytes.length, secondInput.length);
  assert.ok(saved.bytes.equals(input));
  assert.ok(secondSaved.bytes.equals(secondInput));
});
