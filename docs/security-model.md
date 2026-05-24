# Security Model

## Current Encryption Architecture

This application uses **transport-level encryption** between the browser client and the Gateway service.

### What IS Protected

| Segment | Protection |
|---------|-----------|
| Client ↔ Gateway | RSA-OAEP key exchange + AES-256-GCM per-session encryption |
| Gateway ↔ Kafka | Kafka TLS (when configured) |
| Kafka ↔ Message Service | Kafka TLS (when configured) |

### How It Works

1. **Key Exchange**: Client fetches the Gateway's RSA-2048 public key via `GET /crypto/public-key`
2. **Session Key**: Client generates a random AES-256 key, encrypts it with the server's RSA public key, and sends it via `crypto.key_exchange` WebSocket frame
3. **Message Encryption**: All subsequent messages use AES-256-GCM with random 12-byte IVs. The client sends `encrypted_text` (containing `cipher_text`, `iv`, `tag`) instead of plaintext
4. **Server Decryption**: The Gateway decrypts messages server-side before publishing to Kafka

### What is NOT Protected (Threat Model)

| Threat | Status |
|--------|--------|
| Network eavesdropping (MITM) | ✅ Protected — AES-256-GCM with RSA key exchange |
| Compromised Gateway server | ❌ NOT protected — Gateway has plaintext access |
| Compromised database | ❌ NOT protected — Messages stored in plaintext |
| Compromised Kafka broker | ❌ NOT protected — Messages transit in plaintext |
| Server-side operator access | ❌ NOT protected — Operators can read messages |

### Important Disclaimer

> **This is NOT end-to-end encryption.** The server (Gateway) can read all message content. This is architecturally similar to Telegram's default chat mode or Slack — where TLS protects the transport but the server has plaintext access.

### Roadmap: True End-to-End Encryption

For true E2E encryption where the server never sees plaintext:

1. **Client-side key ownership**: Each user generates their own X25519 key pair
2. **Prekey bundles**: Users publish prekeys to the server for asynchronous key exchange
3. **Session establishment**: Signal Protocol Double Ratchet for forward secrecy
4. **Encrypted persistence**: Store only ciphertext in PostgreSQL
5. **Gateway passthrough**: Gateway relays encrypted payloads without decryption

This requires significant client-side cryptography work and is planned for a future release.
