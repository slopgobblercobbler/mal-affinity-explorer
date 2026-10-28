#!/usr/bin/env python3
"""
MAL Affinity Explorer - Local Server & CORS Proxy
Pure Python Standard Library - Zero external dependencies required!

Usage:
    python server.py
    python server.py --port 8080
"""

import os
import sys
import argparse
import urllib.request
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler


class MALProxyHandler(SimpleHTTPRequestHandler):
    """
    Serves static files (index.html, app.js, style.css) and
    proxies API requests to MyAnimeList to bypass browser CORS restrictions.
    """

    def do_OPTIONS(self):
        """Handle CORS pre-flight requests."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        # Check if this is a proxy request
        if self.path.startswith("/api/proxy"):
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            target_url = query.get("url", [None])[0]

            if not target_url:
                self.send_error(400, "Missing 'url' query parameter")
                return

            # Decode target url
            target_url = urllib.parse.unquote(target_url)

            # Security sanity check: only allow myanimelist.net URLs
            parsed_target = urllib.parse.urlparse(target_url)
            if "myanimelist.net" not in parsed_target.netloc:
                self.send_error(403, "Proxy only permits myanimelist.net requests")
                return

            req = urllib.request.Request(
                target_url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0.0.0 Safari/537.36"
                    ),
                    "Accept": "application/json, text/html, */*",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )

            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    content_type = resp.headers.get("Content-Type", "application/json")
                    data = resp.read()

                    self.send_response(resp.status)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                    self.send_header("Cache-Control", "public, max-age=300")
                    self.end_headers()
                    self.wfile.write(data)
            except urllib.error.HTTPError as e:
                self.send_response(e.code)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(e.read())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))
        else:
            # Serve local static files
            super().do_GET()


def run_server(port: int = 8000, host: str = "127.0.0.1"):
    server_address = (host, port)
    httpd = HTTPServer(server_address, MALProxyHandler)
    print(f"\n=======================================================")
    print(f" MAL Affinity Explorer Local Server Running")
    print(f" Web UI:     http://localhost:{port}")
    print(f" CORS Proxy: http://localhost:{port}/api/proxy?url=<target>")
    print(f" Press Ctrl+C to stop the server")
    print(f"=======================================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MAL Affinity Explorer Local Server & Proxy")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")
    args = parser.parse_args()

    run_server(port=args.port, host=args.host)
