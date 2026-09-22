"use strict";

const SENDER_KEY = "webrtc-file-drop:sender:v1";
const RECEIVER_KEY = "webrtc-file-drop:receiver:v1";
const SETTINGS_KEY = "webrtc-file-drop:settings:v1";

function bytes(value) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let number = Number(value);
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) {
    number /= 1024;
    unit += 1;
  }
  return `${number >= 100 || unit === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`;
}

function rate(value) {
  return `${bytes(value)}/s`;
}

function shortHash(value) {
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";
}

function nowMs() {
  return performance.now();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn("Failed to read", key, error);
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function uniqueName(existing, desired) {
  const lower = new Set(Array.from(existing, name => name.toLowerCase()));
  if (!lower.has(desired.toLowerCase())) return desired;
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  let index = 1;
  while (lower.has(`${stem} (${index})${ext}`.toLowerCase())) index += 1;
  return `${stem} (${index})${ext}`;
}

function partName(name) {
  return `${name}.webrtc-part`;
}

self.appUtils = {
  SENDER_KEY,
  RECEIVER_KEY,
  SETTINGS_KEY,
  bytes,
  rate,
  shortHash,
  nowMs,
  escapeHtml,
  downloadText,
  copyText,
  loadJson,
  saveJson,
  uniqueName,
  partName
};
