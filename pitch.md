**Algorithms & Crypto (2–3 lines)**
- We use client-side XSalsa20-Poly1305 (libsodium-style secretbox) for end-to-end ciphertext; the relay never decrypts. Split-delivery (two-part, delayed) plus periodic decoy injection raises the cost of timing-correlation attacks.
- All identifiers and audit entries are recorded as SHA-256 prefixes; randomness is OS-backed CSPRNG (`secrets` on server, Web Crypto in browser) and annotated in logs for auditability.

**New additions (2 lines)**
- Opt-in local agent: keyword + fuzzy matching heuristics (no external calls), quick-reply templates, and an on-device urgency detector; Panic Mode provides a safe persona with canned replies.
- Sender-controlled self-destruct TTLs with server pruning and real-time WebSocket `message_expired` notices; dev-mode protected-queue console notice and dummy decoy enqueue for demo/audit.

**What makes us different (2 lines)**
- Combines low-latency UX (React + WebSocket) with practical metadata resistance (split delivery + adaptive decoys) and auditable hygiene (no raw secrets logged). 
- Privacy-first client automation: useful agent features that run locally and never leak plaintext or model data to the network.

**USP (2–3 bullet points)**
- Real-time ephemeral messaging: TTL-based self-destruct with instant UI removal via expiry notices.
- Practical traffic-analysis mitigation: split-delivery fragmentation + decoy traffic increases adversary cost while preserving chat responsiveness.
- Auditable privacy hygiene: SHA-256 fingerprint logs and explicit CSPRNG provenance demonstrate OS-backed randomness without exposing secrets.

Generated: 2026-04-19
