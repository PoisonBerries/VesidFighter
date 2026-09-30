#!/usr/bin/env python3
"""Local test server for the game, with browser caching turned off so every
refresh gets the files you just changed. Usage: python3 tools/serve.py [port]"""
import http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print(f'Vesid Fighter: http://localhost:{port}/index.html')
http.server.ThreadingHTTPServer(('', port), NoCache).serve_forever()
