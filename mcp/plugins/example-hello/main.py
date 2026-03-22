#!/usr/bin/env python3
"""Example Yaver MCP plugin — communicates via stdio JSON-RPC."""

import json
import sys


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = req.get("method", "")
        req_id = req.get("id")

        if method == "initialize":
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "hello-plugin", "version": "1.0.0"},
                },
            }
        elif method == "tools/list":
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "tools": [
                        {
                            "name": "hello",
                            "description": "Say hello to someone",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string", "description": "Name to greet"}
                                },
                            },
                        }
                    ]
                },
            }
        elif method == "tools/call":
            params = req.get("params", {})
            args = params.get("arguments", {})
            name = args.get("name", "World")
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Hello, {name}! 👋"}]
                },
            }
        else:
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Unknown method: {method}"},
            }

        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
