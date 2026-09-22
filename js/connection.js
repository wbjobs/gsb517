"use strict";

class ConnectionManager extends EventTarget {
  constructor() {
    super();
    this.role = null;
    this.pc = null;
    this.dc = null;
    this.operation = null;
    this.remoteSessionId = null;
    this.candidateTypes = { host: 0, srflx: 0, relay: 0, other: 0 };
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  iceServers() {
    const settings = appUtils.loadJson(appUtils.SETTINGS_KEY, {});
    const servers = [];
    const stunUrls = String(settings.stunUrls || "")
      .split(/\n+/)
      .map(value => value.trim())
      .filter(Boolean);
    if (stunUrls.length) servers.push({ urls: stunUrls });

    const turnUrls = String(settings.turnUrls || "")
      .split(/\n+/)
      .map(value => value.trim())
      .filter(Boolean);
    if (turnUrls.length) {
      servers.push({
        urls: turnUrls,
        username: settings.turnUsername || "",
        credential: settings.turnCredential || ""
      });
    }
    return servers;
  }

  setRole(role) {
    this.close();
    this.role = role;
    this.emitStatus();
  }

  createPeer() {
    if (this.pc) this.closePeer();
    this.candidateTypes = { host: 0, srflx: 0, relay: 0, other: 0 };
    const config = {
      iceServers: this.iceServers(),
      iceCandidatePoolSize: 4
    };
    this.pc = new RTCPeerConnection(config);

    this.pc.onicecandidate = event => {
      if (event.candidate) {
        const type = event.candidate.type || "other";
        this.candidateTypes[type in this.candidateTypes ? type : "other"] += 1;
      }
      this.emitStatus();
    };
    this.pc.onicecandidateerror = event => {
      this.emit("icewarning", {
        error: event.errorText || event.message || "ICE candidate error",
        statusCode: event.statusCode,
        address: event.address
      });
    };
    this.pc.oniceconnectionstatechange = () => this.emitStatus();
    this.pc.onicegatheringstatechange = () => this.emitStatus();
    this.pc.onconnectionstatechange = () => this.emitStatus();
    this.pc.onsignalingstatechange = () => this.emitStatus();

    if (this.role === "offerer") {
      this.bindDataChannel(this.pc.createDataChannel("files-v1", {
        ordered: true
      }));
    } else {
      this.pc.ondatachannel = event => this.bindDataChannel(event.channel);
    }
  }

  bindDataChannel(channel) {
    this.dc = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => {
      this.emitStatus();
      this.emit("dataopen", {});
    };
    channel.onmessage = event => this.emit("datamessage", { data: event.data });
    channel.onbufferedamountlow = () => this.emit("bufferedlow", {});
    channel.onclose = () => {
      this.emitStatus();
      this.emit("dataclosed", {});
    };
    channel.onerror = event => this.emit("dataerror", {
      error: event.error || new Error("DataChannel error")
    });
    this.emitStatus();
  }

  async waitForIce() {
    if (this.pc.iceGatheringState !== "complete") {
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            this.pc.removeEventListener("icegatheringstatechange", finish);
            resolve();
          }
        };
        this.pc.addEventListener("icegatheringstatechange", () => {
          if (this.pc.iceGatheringState === "complete") finish();
        });
        setTimeout(finish, 10000);
      });
    }
  }

  async runOperation(label, callback) {
    while (this.operation) {
      if (this.operation === label) throw new Error("信令操作正在进行中");
      await this.operation.then(() => {}, () => {});
    }
    const run = Promise.resolve().then(callback);
    this.operation = run;
    try {
      return await run;
    } finally {
      if (this.operation === run) this.operation = null;
    }
  }

  async createOffer(options = {}) {
    return this.runOperation("offer", async () => {
      const restart = Boolean(options.restart);
      const fresh = Boolean(options.fresh);
      if (!this.role) this.role = "offerer";
      if (this.role !== "offerer") throw new Error("当前设备是应答方，请粘贴对端 Offer");
      if (!this.pc || fresh) this.createPeer();

      const offer = await this.pc.createOffer(restart ? { iceRestart: true } : undefined);
      await this.pc.setLocalDescription(offer);
      await this.waitForIce();
      this.emitStatus();
      return this.pc.localDescription.toJSON();
    });
  }

  parseSessionId(sdp) {
    const line = String(sdp).split(/\r?\n/).find(item => item.startsWith("o="));
    const parts = line ? line.split(/\s+/) : [];
    return parts[1] || null;
  }

  async acceptOffer(remote) {
    return this.runOperation("answer", async () => {
      if (!this.role) this.role = "answerer";
      if (this.role !== "answerer") throw new Error("当前设备是发起方，请创建 Offer");

      const sdp = typeof remote === "string" ? remote : remote.sdp;
      const sessionId = this.parseSessionId(sdp);
      if (this.pc && this.remoteSessionId && sessionId && sessionId !== this.remoteSessionId) {
        this.closePeer();
      }
      if (!this.pc) this.createPeer();

      const offer = typeof remote === "string"
        ? { type: "offer", sdp: remote }
        : { type: "offer", sdp: remote.sdp };
      await this.pc.setRemoteDescription(offer);
      this.remoteSessionId = sessionId;
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.waitForIce();
      this.emitStatus();
      return this.pc.localDescription.toJSON();
    });
  }

  async applyAnswer(remote) {
    return this.runOperation("answer", async () => {
      if (!this.pc) throw new Error("请先创建 Offer");
      const answer = typeof remote === "string"
        ? { type: "answer", sdp: remote }
        : { type: "answer", sdp: remote.sdp };
      await this.pc.setRemoteDescription(answer);
      this.remoteSessionId = this.parseSessionId(answer.sdp) || this.remoteSessionId;
      this.emitStatus();
    });
  }

  send(message) {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error("DataChannel 未连接");
    }
    this.dc.send(message);
  }

  sendJson(message) {
    this.send(JSON.stringify(message));
  }

  get bufferedAmount() {
    return this.dc ? this.dc.bufferedAmount : 0;
  }

  get channelState() {
    return this.dc ? this.dc.readyState : "none";
  }

  state() {
    return {
      role: this.role || "unset",
      iceConnectionState: this.pc ? this.pc.iceConnectionState : "none",
      connectionState: this.pc ? this.pc.connectionState : "none",
      iceGatheringState: this.pc ? this.pc.iceGatheringState : "none",
      signalingState: this.pc ? this.pc.signalingState : "none",
      channelState: this.channelState,
      bufferedAmount: this.bufferedAmount,
      candidateTypes: { ...this.candidateTypes }
    };
  }

  emitStatus() {
    this.emit("status", this.state());
  }

  closePeer() {
    if (this.dc) {
      try { this.dc.onopen = null; this.dc.onmessage = null; this.dc.onclose = null; this.dc.onerror = null; } catch {}
      try { this.dc.close(); } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.onicecandidate = null; this.pc.onicecandidateerror = null; } catch {}
      try { this.pc.oniceconnectionstatechange = null; this.pc.onconnectionstatechange = null; } catch {}
      try { this.pc.onicegatheringstatechange = null; this.pc.onsignalingstatechange = null; } catch {}
      try { this.pc.ondatachannel = null; } catch {}
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this.remoteSessionId = null;
  }

  close() {
    this.closePeer();
    this.role = null;
    this.emitStatus();
  }
}

self.ConnectionManager = ConnectionManager;
