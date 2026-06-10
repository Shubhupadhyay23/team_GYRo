import asyncio
import os

from models.database import get_neon_client

async def main():
    db = await get_neon_client()
    try:
        migration_files = sorted([f for f in os.listdir("migrations") if f.endswith(".sql")])
        for filename in migration_files:
            filepath = os.path.join("migrations", filename)
            with open(filepath, "r") as f:
                query = f.read()
            
            print(f"Running {filename}...")
            # Split by semicolon using sqlparse or simple string splitting
            statements = query.split(";")
            for stmt in statements:
                stmt = stmt.strip()
                if not stmt:
                    continue
                try:
                    await db.execute(stmt)
                except Exception as e:
                    if "already exists" in str(e) or "Duplicate" in str(e) or "already a column" in str(e):
                        pass
                    else:
                        print(f"Error in stmt '{stmt[:30]}...': {e}")
            print(f"Success: {filename}")
    finally:
        await db.close()

if __name__ == "__main__":
    asyncio.run(main())
