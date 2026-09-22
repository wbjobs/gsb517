# WebRTC 大文件传输

零构建、零运行时依赖的静态网页。两台设备通过手动复制 SDP 建立 WebRTC `RTCDataChannel`，使用 File API 切片读取、Web Worker + Web Crypto 校验分块、File System Access API 流式写盘，并基于已确认偏移断点续传。

## 运行

WebRTC、Worker、剪贴板和目录选择都需要安全上下文：

```bash
npm run serve
# 或
python3 scripts/serve-https.py
```

然后两台设备访问：

```text
https://<运行服务的电脑局域网 IP>:8443
```

自签证书首次访问会有浏览器警告，需要手动继续。也可以把目录部署到任意 HTTPS 静态站点。推荐 Chrome/Edge；接收端依赖 File System Access API。

## SDP 操作顺序

1. 设备 A 点“设备 A / 发起方” → “创建 Offer”，复制本端 SDP。
2. 设备 B 点“设备 B / 应答方”，粘贴 Offer → “生成 Answer”，复制 Answer。
3. 设备 A 粘贴 Answer → “应用 Answer”。
4. 状态变为 `DataChannel 已连接` 后，设备 A 选择文件；设备 B 提前选择接收目录。
5. 如果中途断网，点设备 A 的“ICE 重启：生成新 Offer”，重复第 1–3 步；文件对象和 `.webrtc-part` 临时文件仍保留时会从已确认偏移继续。

> 手动 SDP 模式在 ICE 重启时仍由发起方生成带 `iceRestart:true` 的新 Offer。NAT 完全阻挡 UDP/TCP 直连时，必须在两台设备配置相同 TURN，再建立全新连接。

## 关键实现

- **有限内存**：每次只切片 `64 KiB`，发送端未确认窗口上限 `8 MiB`，DataChannel 本地缓冲达到 `1 MiB` 立即暂停；接收端逐块写入，不拼接完整文件。
- **背压**：发送循环同时检查 `bufferedAmount`、未确认窗口和落盘 ACK；接收端落盘后才授权窗口继续，低于阈值后由 `bufferedamountlow` 或 ACK 事件恢复。
- **分块哈希**：Worker 内对每个 `64 KiB` 数据块调用 `crypto.subtle.digest("SHA-256")`，不匹配则接收端严格丢弃旧窗口数据、回滚流式哈希并从坏块偏移重传。
- **整文件哈希**：Worker 内维护自实现的流式 SHA-256 状态，最终与发送端完整文件哈希比较；哈希一致后 `.webrtc-part` 才改名为正式文件。
- **断点续传**：接收端 ACK 后才推进 durable offset；发送端重连后读取文件前缀重建哈希状态，接收端从临时文件前缀重建哈希状态。
- **多文件队列**：发送端严格串行，一个文件完成后自动启动下一个；单文件失败不会破坏队列。
- **ICE 提示**：页面展示 ICE/Peer/Gathering/DataChannel 状态和 host/srflx/relay 候选数量；`failed/disconnected` 时给出 ICE 重启或 TURN 降级提示。

## 验收建议

1. 生成 1 GiB 随机文件并在两台设备传输：

   ```bash
   dd if=/dev/urandom of=1g.bin bs=64m count=16
   sha256sum 1g.bin
   ```

2. 接收完成后浏览器会显示 SHA-256；在接收设备系统终端对最终文件运行 `sha256sum`，应与发送端一致。
3. 传输中途关闭 Wi-Fi 10 秒后恢复，观察状态和队列；必要时执行 ICE 重启。确认进度从已落盘偏移继续，而不是从 0 开始。
4. 打开浏览器任务管理器，页面内存应保持在数十 MiB 级别波动，不应随 1 GiB 文件线性增长。
5. 人为限速或阻塞接收端，界面应出现“发送缓冲背压：暂停”，恢复后继续。
6. 不配置可用 TURN 且两侧处于严格 NAT 时，页面应显示可读 ICE 失败提示和配置 TURN 的下一步。

## 限制

- 刷新页面后发送端的 `File` 安全句柄无法自动恢复，需要用“重新选择”选择同一个文件；接收端目录句柄保存在 IndexedDB 中，重新授权后可继续临时文件。
- 接收端使用 File System Access API，这是当前浏览器中可安全流式写入大文件且避免内存溢出的关键；不建议退回把所有 Blob 放内存的方案。
- 手动 SDP 不交换 Trickle ICE。程序会等待 gathering 完成（最多 10 秒），复制的是完整 SDP，以减少漏候选导致的连接失败。
