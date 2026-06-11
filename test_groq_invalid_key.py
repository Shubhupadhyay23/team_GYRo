import asyncio
from groq import AsyncGroq
import os

async def main():
    os.environ["GROQ_API_KEY"] = "invalid_key"
    client = AsyncGroq()
    try:
        await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": "hello"}],
            stream=False
        )
    except Exception as e:
        print("EXCEPTION TYPE:", type(e).__name__)
        print("EXCEPTION MSG:", str(e))

asyncio.run(main())
