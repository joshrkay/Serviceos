import logging
import os
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from agent.graph import build_graph

logger = logging.getLogger(__name__)

app = FastAPI(title="ServiceOS Agent", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOWED_ORIGINS", "").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Compile the graph once at startup
agent = build_graph()


class ProcessRequest(BaseModel):
    tenant_id: str
    transcript: str
    input_method: str = "text"


@app.get("/health")
def health():
    return {"status": "ok", "version": "0.1.0"}


@app.post("/process")
async def process(req: ProcessRequest):
    try:
        result = agent.invoke({
            "tenant_id": req.tenant_id,
            "transcript": req.transcript,
            "input_method": req.input_method,
        })

        proposal = result.get("proposal")
        if not proposal:
            raise HTTPException(status_code=500, detail="Agent produced no proposal")

        return proposal

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Unexpected error processing request: %s", req.transcript[:100])
        raise HTTPException(status_code=500, detail="An internal server error occurred.")
