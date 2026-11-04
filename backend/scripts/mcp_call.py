"""MCPサーバーの道具を、Claude Code と同じ通信（stdio）で呼んで結果を見る（確認用。人が手で実行してもよい）。

使い方: .venv\\Scripts\\python.exe backend\\scripts\\mcp_call.py 道具名 [引数のJSON]
例:     .venv\\Scripts\\python.exe backend\\scripts\\mcp_call.py volume "{\\"storey\\": \\"5SL\\"}"
"""
import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[2]


async def main(tool: str, args: dict) -> int:
    params = StdioServerParameters(command=str(ROOT / ".venv" / "Scripts" / "python.exe"),
                                   args=[str(ROOT / "backend" / "mcp_server.py")], cwd=str(ROOT))
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        if tool == "--list":
            for t in (await session.list_tools()).tools:
                print(f"{t.name}: {t.description.splitlines()[0]}")
            return 0
        result = await session.call_tool(tool, args)
        for c in result.content:
            text = getattr(c, "text", "")
            try:
                print(json.dumps(json.loads(text), ensure_ascii=False, indent=1))
            except json.JSONDecodeError:
                print(text)
        return 1 if result.isError else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(asyncio.run(main(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})))
