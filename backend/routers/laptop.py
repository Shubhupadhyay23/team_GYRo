import uuid
from fastapi import APIRouter, HTTPException
from models.database import get_neon_client

router = APIRouter(prefix="/laptop", tags=["laptop"])

@router.post("/guest")
async def create_guest_user():
    """Create a temporary guest user and style profile for the standalone laptop mode."""
    db = await get_neon_client()
    try:
        # Generate random identifiers
        guest_uuid = uuid.uuid4().hex[:8]
        guest_email = f"guest_laptop_{guest_uuid}@example.com"
        
        # 1. Create a dummy user
        user_rows = await db.execute(
            "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
            ["Laptop Guest", guest_email]
        )
        user_id = str(user_rows[0]["id"])
        
        # 2. Create a default style profile so the orchestrator has something to work with
        await db.execute(
            """
            INSERT INTO style_profiles (user_id, style_tags, price_range) 
            VALUES ($1, $2, $3)
            """,
            [user_id, ["casual", "streetwear"], '{"min": 0, "max": 200}']
        )
        
        return {"user_id": user_id}
    except Exception as e:
        print(f"[laptop] Failed to create guest user: {e}")
        raise HTTPException(status_code=500, detail="Failed to create guest session")
    finally:
        await db.close()
