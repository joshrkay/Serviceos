"""
ServiceOsApiClient — HTTP client to the Service OS TS API.

Replaces the direct Supabase access that lived in `agent/nodes.py`. The
Python agent service never talks to the database directly; it calls the
TS API so every write goes through:

  - RLS context set from the tenant JWT
  - Proposal approval gate (draft → ready_for_review → approved → executed)
  - Audit trail (actor, tenant, correlation id)
  - Billing engine invariants (integer cents, never float)

This client is intentionally minimal — it exposes only the endpoints the
MCP servers need, and it accepts a preconfigured base URL + auth token
so the runtime can inject per-tenant credentials.

The transport layer uses httpx with async requests to avoid blocking the
FastAPI event loop while calling the TS gateway.
"""

from __future__ import annotations

import logging
import os
import httpx
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ServiceOsApiError(RuntimeError):
    """Raised when the TS API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"ServiceOsApi error {status}: {body}")
        self.status = status
        self.body = body


@dataclass(frozen=True)
class ServiceOsApiClient:
    """Minimal HTTP client to the Service OS TS API.

    Instances are cheap — create one per request with the caller's
    tenant-scoped token. Per-tenant credential binding lives here, not in
    the agents.
    """

    base_url: str
    auth_token: str
    timeout_seconds: float = 15.0

    @classmethod
    def from_env(cls, auth_token: str) -> "ServiceOsApiClient":
        base = os.environ.get("SERVICE_OS_API_URL")
        if not base:
            raise RuntimeError(
                "SERVICE_OS_API_URL must be set for the Python agent service "
                "to reach the TS API"
            )
        return cls(base_url=base.rstrip("/"), auth_token=auth_token)

    # ── Read-only lookups ─────────────────────────────────────

    async def lookup_customer(
        self,
        *,
        tenant_id: str,
        name: str,
        limit: int = 5,
    ) -> List[Dict[str, Any]]:
        return await self._request(
            "GET",
            f"/api/customers/search",
            query={"q": name, "limit": str(limit)},
            tenant_id=tenant_id,
        )

    async def lookup_recent_jobs(
        self,
        *,
        tenant_id: str,
        customer_id: str,
        limit: int = 5,
    ) -> List[Dict[str, Any]]:
        return await self._request(
            "GET",
            f"/api/customers/{customer_id}/jobs",
            query={"limit": str(limit)},
            tenant_id=tenant_id,
        )

    # ── Writes (all go through the proposal gate) ─────────────

    async def draft_proposal(
        self,
        *,
        tenant_id: str,
        user_id: str,
        proposal_type: str,
        payload: Dict[str, Any],
        summary: str,
        confidence_score: Optional[float] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "tenantId": tenant_id,
            "proposalType": proposal_type,
            "payload": payload,
            "summary": summary,
            "createdBy": user_id,
        }
        if confidence_score is not None:
            body["confidenceScore"] = float(confidence_score)

        return await self._request(
            "POST",
            "/api/proposals",
            json_body=body,
            tenant_id=tenant_id,
        )

    # ── Transport ─────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        tenant_id: str,
        query: Optional[Dict[str, str]] = None,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        if query:
            from urllib.parse import urlencode
            url = f"{url}?{urlencode(query)}"

        headers = {
            "Authorization": f"Bearer {self.auth_token}",
            "Accept": "application/json",
            "X-Tenant-Id": tenant_id,
        }
        data: Optional[bytes] = None
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                resp = await client.request(method, url, headers=headers, content=data)
            resp.raise_for_status()
            if not resp.content:
                return None
            return resp.json()
        except httpx.HTTPStatusError as e:
            body = e.response.text
            logger.warning("ServiceOsApi %s %s → %d: %s", method, path, e.response.status_code, body)
            raise ServiceOsApiError(e.response.status_code, body) from e
