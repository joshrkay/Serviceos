"""
HTTP clients for Service OS Python agents.

The Python agent service does NOT write directly to Supabase. All writes
go through the TS API (`packages/api`) so the proposal approval gate,
audit trail, RLS context, and billing engine invariants are preserved.
The TS API is the system of record; this package holds the clients the
Python service uses to reach it.
"""
