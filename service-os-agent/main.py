import hmac
import logging
import os
from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from agent.graph import build_graph

logger = logging.getLogger(__name__)

app = FastAPI(title="ServiceOS Agent", version="0.1.0")

# An unset/empty CORS_ALLOWED_ORIGINS must mean "no origins", not [""].
_cors_origins = [o.strip() for o in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_service_auth(authorization: str = Header(None)) -> None:
    """Gate write/agent endpoints behind a shared service token.

    Fail-closed: if AGENT_SERVICE_TOKEN is not configured the endpoint is
    unavailable (503) rather than open. A valid request must send
    `Authorization: Bearer <AGENT_SERVICE_TOKEN>`. Compared in constant time.
    """
    expected = os.getenv("AGENT_SERVICE_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="Agent auth not configured")

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")

    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid service token")

# Compile the graph once at startup
agent = build_graph()


class ProcessRequest(BaseModel):
    tenant_id: str
    auth_token: str
    transcript: str
    input_method: str = "text"


@app.get("/health")
def health():
    return {"status": "ok", "version": "0.1.0"}


@app.post("/process", dependencies=[Depends(require_service_auth)])
async def process(req: ProcessRequest):
    try:
        result = agent.invoke({
            "tenant_id": req.tenant_id,
            "auth_token": req.auth_token,
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
