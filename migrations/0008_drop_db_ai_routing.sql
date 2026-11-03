-- ChatDDB Migration 0008: Drop dynamic AI routing tables
-- Replaced by static worker/catalog.ts and worker/routing.ts.
-- Preserves historical chat_messages.model_provider and all message data.

DROP TABLE IF EXISTS route_health;
DROP TABLE IF EXISTS ai_routes;
DROP TABLE IF EXISTS api_providers;
DROP TABLE IF EXISTS ai_services;
