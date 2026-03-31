# Scaling Notes

## Horizontal Gateway Scaling

- Scale gateways with Docker Compose:
  - `docker compose up --build --scale gateway=3 gateway-lb`
- `gateway-lb` (NGINX) fronts WebSocket and HTTP traffic on port `8080`.
- Gateway consumers use instance-specific Kafka consumer groups (`<base-group>-<instance-id>`) so each gateway receives the full `events` and `presence` streams and can fan out to its own connected sockets.

## Kafka Partitioning Strategy

- Topics:
  - `messages`
  - `events`
  - `presence`
- All message/event/presence publishes use `chat_id` as the Kafka key.
- This preserves per-chat ordering within each topic partition while allowing independent chats to scale across partitions.

## Delivery Semantics

- Consumers run with `autoCommit: false`.
- Offsets are committed only after successful handler completion.
- On handler failures, retry with bounded backoff before surfacing errors.
- Poison payloads (invalid JSON) are logged and committed to avoid partition starvation.

## Operational Considerations

- For production, run Kafka with replication factor > 1 and multiple brokers.
- Use sticky load balancing (or session affinity) for lower reconnect churn during gateway failover.
- Add autoscaling based on WebSocket connections and consumer lag.
- Enable centralized logging and metrics (consumer lag, publish latency, DB write latency, reconnect rate).
