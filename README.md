# Kafka Chat Application

Signal-inspired real-time distributed chat built with Node.js microservices, WebSockets, Kafka, React, and Docker Compose.

## Features

- WebSocket gateway with JWT authentication.
- Durable chat pipeline (`messages` topic) with PostgreSQL persistence.
- Real-time fanout pipeline (`events` topic) for delivered messages, typing indicators, and read receipts.
- Presence pipeline (`presence` topic) for online/offline updates.
- Dead-letter pipeline (`dead_letters` topic) for malformed/failed payload triage.
- Idempotent message and read-receipt writes.
- RSA-OAEP key exchange and AES-256-GCM transport encryption between client and gateway.
- Room history replay on join (`chat.history`) fetched from message-service.
- Gateway frame-size + per-connection rate limiting to reduce abuse risk.
- `/health` and `/ready` probes for gateway and message-service.
- Horizontal gateway scaling support with load-balancer front door.

## Services

- `services/gateway`: WebSocket/HTTP gateway, auth, Kafka producer/consumers, session tracking.
- `services/message-service`: Kafka consumers, PostgreSQL persistence, delivery event publisher.
- `web/client`: React + Vite client for chat UX, typing, read receipts, and encrypted transport.

## Kafka Topic Design

- `messages`
  - Producer: gateway
  - Consumer: message-service
  - Key: `chat_id` (keeps per-chat message order)
- `events`
  - Producer: gateway (typing/read), message-service (deliver)
  - Consumers: gateway, message-service
  - Key: `chat_id` (keeps per-chat event order)
- `presence`
  - Producer: gateway
  - Consumer: gateway
  - Key: `chat_id` (keeps per-chat presence ordering)
- `dead_letters`
  - Producer: message-service (invalid/failed message/event processing)
  - Consumer: ops tooling / replay jobs
  - Key: `chat_id` when available

## Reliability Semantics

- Consumers run with `autoCommit: false`.
- Offsets are committed only after successful processing/fanout.
- Handler retries use bounded backoff for transient failures.
- Payload shape is validated before DB writes.
- Malformed/invalid/failed payloads are published to `dead_letters` for audit and replay.
- Malformed payloads are committed after DLQ publication to prevent partition stalls.

## Architecture Diagram (Text)

```text
+--------------------+          ws/http          +-------------------------+
|   React Client     | <-----------------------> |   Gateway Service       |
| (Vite, browser)    |                           | (JWT, WebSocket, Kafka) |
+--------------------+                           +-----------+-------------+
                                                             |
               +---------------------------------------------+---------------------------------------------+
               |                                                                                           |
        produce messages/events/presence                                                            consume events/presence
               |                                                                                           |
               v                                                                                           v
       +--------------------+                                                                   +--------------------+
       |     Kafka          | <-------------------- produce deliver events ---------------------- |  Message Service   |
       | topics:            |                                                                   | (consume messages, |
       | messages/events/   | -------------------- consume messages/events --------------------> | persist, publish)  |
       | presence           |                                                                   +---------+----------+
       +--------------------+                                                                             |
                                                                                                           |
                                                                                                  write idempotent rows
                                                                                                           |
                                                                                                           v
                                                                                                   +---------------+
                                                                                                   |  PostgreSQL   |
                                                                                                   | messages,     |
                                                                                                   | read_receipts |
                                                                                                   +---------------+
```

A standalone copy is available in `docs/architecture.txt`.

## Setup Guide

### 1. Prerequisites

- Node.js 22+
- npm 10+
- Docker + Docker Compose (for Kafka/Postgres and optional full stack)

### 2. Environment

```bash
cp .env.example .env
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Start Infra (Kafka + Postgres)

```bash
docker compose up -d zookeeper kafka postgres
```

### 5. Start App in Development Mode

```bash
npm run dev
```

- Gateway: `http://localhost:8080`
- Message Service health: `http://localhost:8090/health`
- Client: `http://localhost:5173`

### 6. Full Docker Stack (Optional)

```bash
docker compose up --build -d
```

This starts:

- `gateway`
- `message-service`
- `gateway-lb` (listens on `:8080`)
- Kafka/Zookeeper/Postgres

### 7. Scale Gateway Instances

```bash
docker compose up --build -d --scale gateway=3 gateway message-service gateway-lb
```

Use `gateway-lb` endpoint (`http://localhost:8080`, `ws://localhost:8080/ws`) when scaled.

## Operational Endpoints

- Gateway
  - `GET /health`
  - `GET /ready`
  - `GET /crypto/public-key`
  - `GET /dev/token?user_id=<id>` (non-production only)
- Message Service
  - `GET /health`
  - `GET /ready`
  - `GET /messages?chat_id=<id>&limit=30&before=<iso>`

## Development Workflow

Use these scripts from the repo root:

- `npm run dev`
- `npm run dev:gateway`
- `npm run dev:message`
- `npm run dev:client`
- `npm run build:client`

## Security Note

Current encryption is transport-level between browser and gateway session. For strict end-to-end cryptography where server cannot decrypt content, add client-side key ownership and encrypted payload persistence without gateway plaintext handling.
