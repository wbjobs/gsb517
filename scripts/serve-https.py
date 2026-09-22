#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ssl
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import TCPServer


def ensure_certificate(cert_dir: Path) -> tuple[Path, Path]:
    cert_dir.mkdir(parents=True, exist_ok=True)
    certfile = cert_dir / "cert.pem"
    keyfile = cert_dir / "key.pem"
    if certfile.exists() and keyfile.exists():
        return certfile, keyfile

    command = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(keyfile),
        "-out", str(certfile),
        "-days", "365",
        "-subj", "/CN=webrtc-file-drop.local",
        "-addext", "subjectAltName=DNS:localhost,IP:0.0.0.0"
    ]
    try:
        subprocess.run(command, check=True)
    except FileNotFoundError:
        raise SystemExit("未找到 openssl，无法自动生成自签证书。")
    return certfile, keyfile


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8443)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    certfile, keyfile = ensure_certificate(root / ".cert")
    handler = partial(SimpleHTTPRequestHandler, directory=root)
    TCPServer.allow_reuse_address = True

    with TCPServer((args.host, args.port), handler) as httpd:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile, keyfile)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        print(f"Serving {root} on https://{args.host}:{args.port}")
        print("首次打开浏览器会提示自签证书不受信任，需要手动继续。")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
