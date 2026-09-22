# WebRTC 手动 SDP 大文件传输

零依赖静态网页，用于两台设备通过手动复制/粘贴 SDP 建立 WebRTC DataChannel，然后传输 1GB 以上文件。

## 启动

```bash
python3 -m http.server 8000
```

浏览器打开 `http://<本机 IP>:8000/`。不要直接用 `file://` 打开，因为 Worker、ES Module 和 OPFS 需要 HTTP(S) 源。

## 手动 SDP

1. 发起方点击“创建 Offer”，复制本机 SDP。
2. 接收方粘贴 Offer，点击“生成 Answer”，复制 Answer。
3. 发起方粘贴 Answer，点击“应用 Answer”。
4. 页面使用非 trickle SDP，并等待短时间收集候选；SDP 必须整段复制。

## 文件传输

- 发送端通过 File API 按小块读取文件，不把整个文件读入内存。
- 接收端在 Web Worker 中使用 OPFS SyncAccessHandle 按偏移落盘。
- 默认 32 KiB 分块，所有分块附加 SHA-256；整文件在末尾做增量 SHA-256 校验。
- 接收端持久化已确认偏移和增量哈希状态，重连后发送方从确认点重新读取并重放。
- 支持多文件队列，当前文件完成后自动启动下一个排队文件。
- 发送端信用窗口最多保留 8 个分块，DataChannel `bufferedAmount` 超过 1 MiB 时停止请求 Worker 读新块，降到 384 KiB 以下再恢复。

## ICE 失败降级

同一局域网或使用 STUN 通常可直连。跨对称 NAT 时需要 TURN。把带凭证的配置填入 ICE Servers，例如：

```json
[
  {"urls":"stun:stun.cloudflare.com:3478"},
  {"urls":"turn:turn.example.org:3478","username":"user","credential":"pass"}
]
```

ICE failed 后：

- 发起方点“ICE 失败后重启”，重新交换 Offer/Answer，DataChannel 和文件进度不关闭。
- 若直连和 STUN 都失败，双方勾选“仅使用 TURN 中继”并重新创建 SDP，可强制走 relay。
- 若浏览器/网络环境异常，点击“断开并新建连接”；已落盘的接收进度仍可复用。

## 建议验收

1. 准备至少 1GB 文件，两端打开页面并建立连接。
2. 观察队列进度、速度和 `buffer` 数值；高吞吐时应出现背压提示并暂停增长。
3. 传输中断网或关闭 DataChannel，恢复/重协商后续传。
4. 完成后接收端点“保存”，用系统工具比较 SHA-256。
5. 删除 OPFS 中的已完成文件后，再重新发送可从零开始。

推荐使用最新版 Chromium/Edge；OPFS SyncAccessHandle 在 Worker 中支持最完整。
