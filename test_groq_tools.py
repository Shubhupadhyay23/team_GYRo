import asyncio
from dotenv import load_dotenv
load_dotenv("backend/.env")

from groq import AsyncGroq
from backend.agent.tools import TOOL_DEFINITIONS

async def main():
    client = AsyncGroq()
    try:
        stream = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": "hi"}],
            tools=TOOL_DEFINITIONS,
            stream=True
        )
        async for chunk in stream:
            pass
        print("SUCCESS")
    except Exception as e:
        print(f"ERROR: {e}")

asyncio.run(main())
