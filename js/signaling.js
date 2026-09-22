const OFFER_MARKER = "v=0";

export class SignalingManager {
  constructor({ getConfig, onChannel, onStatus }) {
    this.getConfig = getConfig;
    this.onChannel = onChannel;
    this.onStatus = onStatus;
    this.pc = null;
    this.lastOfferFingerprints = "";
    this.channel = null;
    this.role = "host";
    this.localStreamId = "";
    this.peerStreamId = "";
    this.connectionGeneration = 0;
  }

  setRole(role) {
    this.role = role;
  }

  async createOffer() {
    await this.close(false);
    this.createPeer();
    this.channel = this.pc.createDataChannel("file-transfer", { ordered: true });
    this.bindChannel(this.channel, true);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIce(this.pc);
    return this.pc.localDescription.sdp;
  }

  async createAnswer(offerSdp, relayOnly) {
    const incomingFingerprints = fingerprints(offerSdp).join(",");
    const reusable = this.pc
      && this.lastOfferFingerprints
      && incomingFingerprints
      && incomingFingerprints === this.lastOfferFingerprints;
    if (!reusable || relayOnly) await this.close(false, false);
    if (!this.pc) this.createPeer();

    await this.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    this.lastOfferFingerprints = incomingFingerprints;
    const answer = await this.pc.createAnswer(relayOnly ? { iceRestart: true } : undefined);
    await this.pc.setLocalDescription(answer);
    await waitForIce(this.pc);
    return this.pc.localDescription.sdp;
  }

  async acceptAnswer(answerSdp) {
    if (!this.pc) throw new Error("请先创建 Offer。");
    const fingerprintsNow = fingerprints(answerSdp).join(",");
    await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  async restartOffer() {
    if (!this.pc || this.role !== "host") throw new Error("只有发起方可以在当前连接上发起 ICE 重启。");
    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    await waitForIce(this.pc);
    return this.pc.localDescription.sdp;
  }

  async close(announce = true, clearFingerprints = true) {
    const oldChannel = this.channel;
    const oldPc = this.pc;
    this.connectionGeneration += 1;
    this.channel = null;
    this.pc = null;
    this.peerStreamId = "";
    if (clearFingerprints) this.lastOfferFingerprints = "";
    if (announce && oldChannel && oldChannel.readyState === "open") oldChannel.close();
    if (oldPc) {
      oldPc.ondatachannel = null;
      oldPc.onconnectionstatechange = null;
      oldPc.oniceconnectionstatechange = null;
      try { oldPc.close(); } catch { /* ignore */ }
    }
  }

  createPeer() {
    this.connectionGeneration += 1;
    const config = this.getConfig();
    this.pc = new RTCPeerConnection(config);
    this.pc.onconnectionstatechange = () => {
      this.onStatus(this.pc?.connectionState || "closed", "connection");
    };
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc?.iceConnectionState;
      if (state === "failed" || state === "disconnected" || state === "connected") {
        this.onStatus(state, "ice");
      }
    };
    this.pc.ondatachannel = (event) => {
      this.channel = event.channel;
      this.bindChannel(this.channel, false);
    };
  }

  bindChannel(channel, isInitiator) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => {
      this.onStatus("open", "connection");
      this.onChannel(channel, this.connectionGeneration, isInitiator);
    };
    channel.onbufferedamountlow = () => this.onStatus("buffered-low", "channel");
    channel.onclose = () => {
      this.onStatus("closed", "channel");
      this.peerStreamId = "";
    };
    channel.onerror = () => this.onStatus("error", "channel");
  }
}

export function normalizeSdp(text) {
  const value = text.trim();
  if (!value.includes(OFFER_MARKER)) throw new Error("内容不像 SDP：必须包含 v=0 起始行。");
  return value;
}

export function fingerprints(sdp) {
  return Array.from(sdp.matchAll(/^a=fingerprint:\S+\s+([0-9a-fA-F:]+)/gm), (match) => match[1]).sort();
}

function waitForIce(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, 5000);
    const onChange = () => {
      if (pc.iceGatheringState === "complete" || pc.iceGatheringState === "failed") {
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}
