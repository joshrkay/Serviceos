-- Message external-id dedup is an INBOUND concern (webhook redelivery).
-- Outbound rows store the provider sid for provenance only and must never
-- collide (provider sid uniqueness is not ours to assume).

DROP INDEX messages_external_id_idx;
CREATE UNIQUE INDEX messages_external_id_idx ON messages(tenant_id, external_id)
  WHERE external_id IS NOT NULL AND direction = 'inbound';
