import asyncio
from models.database import get_neon_client

async def main():
    db = await get_neon_client()
    try:
        rows = await db.execute("""
            SELECT conname, contype 
            FROM pg_constraint 
            WHERE conrelid = 'style_profiles'::regclass;
        """)
        print("style_profiles constraints:")
        for r in rows:
            print(r)
            
        rows2 = await db.execute("""
            SELECT conname, contype 
            FROM pg_constraint 
            WHERE conrelid = 'queue'::regclass;
        """)
        print("queue constraints:")
        for r in rows2:
            print(r)
    except Exception as e:
        print(f"Error: {e}")
    finally:
        await db.close()

if __name__ == "__main__":
    asyncio.run(main())
