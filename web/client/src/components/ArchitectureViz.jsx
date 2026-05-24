import React, { useState } from 'react';

const NODES = [
  {
    id: 'client', label: 'React Client', icon: '🖥',
    desc: 'Browser-based React SPA with Vite. Handles AES-256-GCM encryption, WebSocket framing, typing indicators, and read receipts.',
    failure: 'Client disconnects trigger presence updates via Kafka. Auto-reconnect with exponential backoff restores sessions.',
    scaling: 'Stateless — unlimited clients behind any CDN. No server affinity required.',
  },
  {
    id: 'gateway', label: 'Gateway Service', icon: '🔀',
    desc: 'WebSocket/HTTP gateway handling JWT auth, RSA key exchange, Kafka producing, rate limiting, and per-instance event fanout.',
    failure: 'Nginx LB detects unhealthy instances. Clients reconnect to surviving nodes. Kafka consumer groups rebalance automatically.',
    scaling: 'Horizontally scalable — each instance gets its own consumer group. Scale with `docker compose --scale gateway=N`.',
  },
  {
    id: 'kafka', label: 'Apache Kafka', icon: '📨',
    desc: 'Durable message broker with 4 topics: messages (6 partitions), events (6), presence (3), dead_letters (6). Partition keys use chat_id for ordering.',
    failure: 'Replication factor handles broker failures. Consumer offset commits ensure at-least-once delivery. DLQ captures poison messages.',
    scaling: 'Add brokers to the cluster. Increase partition count for higher throughput. KafkaJS handles broker discovery.',
  },
  {
    id: 'message-service', label: 'Message Service', icon: '⚙️',
    desc: 'Kafka consumer that persists messages to PostgreSQL with idempotent writes, processes read receipts, and publishes delivery events.',
    failure: 'Bounded retry with backoff for DB failures. Failed messages published to dead_letters topic. Health probes trigger restarts.',
    scaling: 'Scale consumers within the group — Kafka auto-rebalances partitions. Each instance handles a partition subset.',
  },
  {
    id: 'postgres', label: 'PostgreSQL', icon: '🗄',
    desc: 'Primary data store with messages and read_receipts tables. Indexed by (chat_id, created_at DESC) for efficient history queries.',
    failure: 'Connection pool with 5-retry backoff. Idempotent writes (ON CONFLICT DO NOTHING) prevent duplicates on replays.',
    scaling: 'Read replicas for history queries. Connection pooling via PgBouncer. Partition tables by date for large datasets.',
  },
];

export default function ArchitectureViz() {
  const [active, setActive] = useState(null);
  const node = active !== null ? NODES[active] : null;

  return (
    <section className="arch-section" id="architecture">
      <div className="arch-section-inner">
        <div className="section-header">
          <span className="section-badge">System Design</span>
          <h2>Architecture</h2>
          <p>Click any component to explore its purpose, failure modes, and scaling strategy.</p>
        </div>

        <div className="arch-interactive">
          <div className="arch-nodes-row">
            {NODES.map((n, i) => (
              <React.Fragment key={n.id}>
                <button
                  className={`arch-inode ${active === i ? 'selected' : ''}`}
                  onClick={() => setActive(active === i ? null : i)}
                  aria-expanded={active === i}
                  aria-label={`View details for ${n.label}`}
                >
                  <span className="arch-inode-icon">{n.icon}</span>
                  <span className="arch-inode-label">{n.label}</span>
                </button>
                {i < NODES.length - 1 && (
                  <div className="arch-iedge">
                    <div className="arch-iparticle" style={{ animationDelay: `${i * 0.5}s` }} />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>

          {node && (
            <div className="arch-detail" role="region" aria-label={`${node.label} details`}>
              <h3>{node.icon} {node.label}</h3>
              <div className="arch-detail-grid">
                <div className="arch-detail-card">
                  <h4>Purpose</h4>
                  <p>{node.desc}</p>
                </div>
                <div className="arch-detail-card">
                  <h4>Failure Modes</h4>
                  <p>{node.failure}</p>
                </div>
                <div className="arch-detail-card">
                  <h4>Scaling Strategy</h4>
                  <p>{node.scaling}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
