# KafkaChat Project Context

## Architecture
KafkaChat is a Kafka-backed real-time messaging system with a browser client, a WebSocket gateway, Kafka streams, and a PostgreSQL persistence layer. The gateway issues and validates JWTs for dev sign-in, performs optional transport encryption, and fans out events to connected clients. The message service performs idempotent writes and publishes delivery events. A DLQ worker consumes dead-letter events for retry/audit statistics. See the high-level diagram in [docs/architecture.txt](docs/architecture.txt) and the security posture in [docs/security-model.md](docs/security-model.md).

## Services
- Gateway service (WebSocket + HTTP): port 8080
- Message service (Kafka consumer + REST history): port 8090
- DLQ worker (dead letter retry + stats): port 8095
- Web client (React + Vite): port 5173
- Infra: Kafka, Zookeeper, PostgreSQL, Redis, and optional Nginx load balancer

## Kafka Topics
Topics are auto-created with fixed partitions. Producers use `chat_id` as the Kafka key to preserve ordering per chat.
- `messages` (6 partitions): gateway -> message-service
- `events` (6 partitions): gateway + message-service -> gateway/message-service
- `presence` (3 partitions): gateway -> gateway
- `dead_letters` (6 partitions): message-service -> dlq-worker

## Database Schema (PostgreSQL)
Schema is created at runtime in the message service:
- `messages`
  - `message_id` TEXT PRIMARY KEY
  - `chat_id` TEXT NOT NULL
  - `user_id` TEXT NOT NULL
  - `body_text` TEXT NOT NULL
  - `created_at` TIMESTAMPTZ NOT NULL
  - `received_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
  - Index: `(chat_id, created_at DESC)`
- `read_receipts`
  - `chat_id` TEXT NOT NULL
  - `message_id` TEXT NOT NULL
  - `user_id` TEXT NOT NULL
  - `read_at` TIMESTAMPTZ NOT NULL
  - `received_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
  - PRIMARY KEY `(chat_id, message_id, user_id)`
  - Index: `(message_id, read_at DESC)`

## Frontend Structure
React client lives in [web/client](web/client). Key folders:
- [web/client/src/components](web/client/src/components): UI panels and layout blocks
- [web/client/src/hooks](web/client/src/hooks): `useAuth`, `useChat`
- [web/client/src/lib](web/client/src/lib): encryption helpers, auth helpers, utils

## Existing Auth Flow (Baseline)
- Client supports Google sign-in using Google Identity scripts.
- Email/password sign-in and sign-up are supported using a Firebase API key if configured.
- If no Firebase API key is set, email/password uses a local browser-only fallback (localStorage) for dev.
- Gateway provides a dev JWT endpoint (`/dev/token`) which is used by the client after sign-in.
- No server-side user database is implemented yet; auth is client-assisted and dev-oriented.

## Deployment
- Docker Compose: [docker-compose.yml](docker-compose.yml) runs Kafka, Postgres, Redis, gateway, message-service, DLQ worker, and Nginx load balancer.
- Kubernetes manifests: [k8s](k8s) contains namespace, configmap, deployments, ingress, and HPA for gateway.
- Nginx config: [infra/nginx/gateway.conf](infra/nginx/gateway.conf)

## Run Commands
Local development:

```bash
cp .env.example .env
npm install
npm run docker:infra
npm run dev
```

Full Docker stack:

```bash
docker compose up --build -d
```

## Known Issues / Gaps
- Auth is not yet backed by a server-side user store or session database.
- Redis is provisioned but not yet integrated into runtime logic.
- No production-grade OAuth server-side token exchange exists.

## Roadmap
- v0.2: Authentication
- v0.3: User discovery + contacts
- v0.4: Direct messaging
- v0.5: Groups + permissions
- v0.6: Channels/communities
- v0.7: Media upload
- v0.8: Presence system
- v0.9: Notifications
- v1.0: Encryption complete
