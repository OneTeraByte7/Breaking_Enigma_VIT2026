# Breaking Enigma — Presentation Draft

## Problem
- Secure, private peer-to-peer messaging over an untrusted relay is challenging when adversaries can observe metadata and traffic patterns.
- Simple relays that forward ciphertext expose linkability, timing, and volume cues that enable traffic analysis and deanonymization.
- Senders sometimes need ephemeral messages (self-destruct TTL) and real-time UX to appear removed from recipients' views.

## Existing Solutions — Drawbacks
- Centralized E2EE platforms: good message confidentiality but relay operators still learn metadata (who talks to whom, when, volume).
- Mix networks and anonymizing overlays: strong privacy but high latency, poor UX for real-time messaging, and complex deployment.
- Simple relays with naive decoys: either too few decoys (ineffective) or obvious patterns that leak being a dummy.
- Client-side agents that call external AI services: introduces privacy leak and external dependencies.

## Our Solution
- A privacy-preserving relay that stores opaque ciphertext only and performs split delivery (two-part delayed delivery) to frustrate timing correlation.
- Sender-controlled self-destruct TTLs propagated through the relay; the relay prunes expired messages and emits real-time expiry notices over WebSocket for instant client removal.
- Built-in dev/proof logs that surface only cryptographic SHA-256 prefixes and CSPRNG provenance (no raw secrets) for auditability.
- Local-only client agent (opt-in) that runs keyword/heuristic detection and quick-reply templates without sending plaintext or model data to external services.
- CSPRNG everywhere: server uses OS-backed `secrets`, client uses Web Crypto, dev stubs use Node `crypto` — logs annotate provenance.

## Unique Selling Proposition (USP)
- Real-time ephemeral messaging with verifiable privacy hygiene: TTL + real-time expiry notices + non-sensitive audit traces for judges.
- Low-latency, practical UX (React frontend + WebSocket) while significantly raising the bar for traffic analysis via split delivery + decoy injection.
- Privacy-first agentic features: useful client-side automation that is opt-in, local-only, and auditable.

## Advantages
- Stronger metadata resistance than naive relays, with modest latency overhead suitable for real-time chats.
- Clear audit trail for CSPRNG and message handling that does not reveal plaintext or raw identifiers.
- Developer-friendly: dev-mode decoy injections and protected-queue console notices to demonstrate privacy properties during demos.
- Extensible: architecture supports adding local image/audio detectors and pluggable decoy strategies.

## Future Scope
- Add client-side ML detectors (on-device TF.js / ONNX) for image and audio urgency signals.
- Integrate configurable decoy strategies (timing, size, and frequency) with adaptive mixing algorithms.
- Formal analysis of split-delivery and decoy efficacy against traffic-correlation adversaries.
- Hardening for production: persistent encrypted queues, rate-limited decoy throttles, and audited key rotation.

---

## Architecture (Mermaid)

```mermaid
flowchart LR
  subgraph Client
    C[User App (React)]
    A[Local Agent (opt-in)]
  end

  subgraph Relay
    R[WebSocket Relay (FastAPI/uvicorn)]
    S[Store (in-memory / persistent)]
    SP[Split Delivery Service]
    DC[Decoy Injector]
    AUD[Audit Logs (SHA-256 prefixes)]
  end

  C -- "POST ciphertext (base64)" --> R
  C -- "WS subscribe" --> R
  R -- "enqueue" --> S
  R -- "split->parts" --> SP
  SP -- "part1 (delayed)" --> R
  SP -- "part2" --> R
  DC -- "periodic decoys" --> S
  R -- "fanout parts/events" --> C
  S -- "prune expired -> emit message_expired" --> R
  R -- "audit (hashes + CSPRNG provenance)" --> AUD
  A -- "local detection" --- C

  click AUD "#" "Audit is stored as non-sensitive SHA-256 prefixes"
```

Notes:
- All arrows between client and relay carry opaque base64 ciphertext; relay never decrypts.
- Audit trail intentionally records only SHA-256 prefixes and RNG provenance (e.g., "secrets.token_bytes — CSPRNG") to prove OS-backed randomness without leaking secrets.
- Split delivery introduces deliberate micro-delay and fragmentation to make timing correlation harder.

---

## Demo Checklist
- Start relay in dev mode (annotated logs showing CSPRNG provenance).
- Open two client tabs, exchange messages with and without TTL.
- Observe expiry notices appearing instantly and messages removed from both UIs.
- Show dev console: protected-queue fingerprint and a dummy decoy enqueue entry.


---

Generated on: 2026-04-19
