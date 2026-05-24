# KafkaChat — Distributed Realtime Messaging Platform

Production-grade realtime chat built with Node.js microservices, Apache Kafka, WebSockets, PostgreSQL, React, and Docker Compose.

## Architecture

```text
┌──────────────┐     ws/http     ┌───────────────────┐
│ React Client │ ◄─────────────► │  Gateway Service   │
│ (Vite, SPA)  │                 │ (JWT, WS, Kafka)   │
└──────────────┘                 └─────────┬─────────┘
                                           │
        ┌──────────────────────────────────┼───────────────────────────┐
        │ produce msgs/events/presence     │            consume events/presence
        ▼                                  │                          ▼
┌──────────────┐                   ┌───────┴──────┐         ┌──────────────┐
│  Apache Kafka │ ◄── deliver ──── │   Message    │         │  DLQ Worker  │
│  4 topics     │ ── consume ────► │   Service    │         │  (retry/audit)│
└──────────────┘                   └──────┬───────┘         └──────────────┘
                                          │
                                  idempotent writes
                                          ▼
                                  ┌──────────────┐
                                  │  PostgreSQL   │
                                  │  messages,    │
                                  │  read_receipts│
                                  └──────────────┘
```

## Features

### Messaging
- WebSocket gateway with JWT authentication
- Durable chat pipeline (`messages` topic) with PostgreSQL persistence
- Real-time fanout pipeline (`events` topic) for delivered messages, typing indicators, and read receipts
- Presence pipeline (`presence` topic) for online/offline updates
- Idempotent message and read-receipt writes

### Security
- RSA-OAEP key exchange and AES-256-GCM transport encryption
- Per-connection rate limiting and frame-size limits
- See [Security Model](docs/security-model.md) for full threat model

### Reliability
- Dead-letter pipeline with DLQ worker (retry, audit, stats)
- Manual offset commits for at-least-once delivery
- Bounded backoff retry for transient failures
- Health and readiness probes on all services
- Graceful shutdown with signal handlers

### Scaling
- Horizontal gateway scaling with per-instance consumer groups
- Nginx load balancer for gateway instances
- Kubernetes deployment configs with HPA autoscaling
- Redis ready for session store migration

### Frontend
- Professional landing page with live architecture visualization
- Interactive architecture explorer (click components for details)
- Live system metrics from gateway health endpoint
- Modern design system (Inter font, zinc palette, 8px grid)
- Component-based React architecture (15+ focused components)
- Auto-reconnect with exponential backoff
- Skeleton loading states
- Read receipts (✓ ✓✓) and typing indicators

## Services

| Service | Port | Purpose |
|---------|------|---------|
| `services/gateway` | 8080 | WebSocket/HTTP gateway, auth, Kafka producer/consumers |
| `services/message-service` | 8090 | Kafka consumers, PostgreSQL persistence, delivery events |
| `services/dlq-worker` | 8095 | Dead letter queue consumer, retry, audit stats |
| `web/client` | 5173 | React + Vite client |

## Kafka Topic Design

| Topic | Producer | Consumer | Key |
|-------|----------|----------|-----|
| `messages` | Gateway | Message Service | `chat_id` |
| `events` | Gateway, Message Service | Gateway, Message Service | `chat_id` |
| `presence` | Gateway | Gateway | `chat_id` |
| `dead_letters` | Message Service | DLQ Worker | `chat_id` |

## Setup Guide

### Prerequisites
- Node.js 22+, npm 10+
- Docker + Docker Compose

### Quick Start

```bash
cp .env.example .env
npm install
docker compose up -d zookeeper kafka postgres    # Start infra
npm run dev                                       # Start all services
```

- Gateway: `http://localhost:8080`
- Client: `http://localhost:5173`
- Message Service: `http://localhost:8090/health`

### Full Docker Stack

```bash
docker compose up --build -d
```

### Scale Gateway

```bash
docker compose up --build -d --scale gateway=3 gateway message-service gateway-lb
```

## Kubernetes Deployment

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl create secret generic kafka-chat-secrets \
  --namespace kafka-chat \
  --from-literal=JWT_SECRET=your-secret \
  --from-literal=POSTGRES_USER=chatuser \
  --from-literal=POSTGRES_PASSWORD=chatpass
kubectl apply -f k8s/deployments.yaml
kubectl apply -f k8s/ingress.yaml
```

## API Endpoints

| Endpoint | Service | Description |
|----------|---------|-------------|
| `GET /health` | Gateway | Health check with readiness status |
| `GET /ready` | Gateway | Readiness probe |
| `GET /crypto/public-key` | Gateway | RSA public key for encryption |
| `GET /dev/token?user_id=&name=` | Gateway | Dev token (non-production) |
| `GET /messages?chat_id=&limit=&before=` | Message Service | Paginated message history |
| `GET /dlq/stats` | DLQ Worker | Dead letter queue statistics |

## CI/CD

GitHub Actions workflows in `.github/workflows/`:
- **ci.yml**: Build client, Docker images, integration health checks

## Development Scripts

```bash
npm run dev              # All services
npm run dev:gateway      # Gateway only
npm run dev:message      # Message service only
npm run dev:dlq          # DLQ worker only
npm run dev:client       # Frontend only
npm run build:client     # Production build
```
