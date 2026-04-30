# 🔐 Breaking Enigma  Secure, Decoy-Enhanced Relay

**Breaking Enigma** is an experimental, research-oriented secure messaging relay
and reference client. It demonstrates practical techniques that make simple
traffic analysis harder while preserving end-to-end encryption between peers.

--

![Top 50 Teams](https://img.shields.io/badge/Achievement-Top%2050%20Teams-orange?style=for-the-badge&logo=trophy)
![Agentic AI](https://img.shields.io/badge/Domain-Agentic%20AI-purple?style=for-the-badge&logo=openai)
![Python](https://img.shields.io/badge/Language-Python-yellow?style=for-the-badge&logo=python)
![Status](https://img.shields.io/badge/Status-Completed-brightgreen?style=for-the-badge&logo=checkmarx)

--

## Table of Contents
- [Highlights](#highlights-✨)
- [Repository Structure](#repository-structure-📁)
- [Quick Start (local)](#quick-start-local-🚀)
- [Fonts & UI Styling](#fonts--ui-styling-🎨)
- [Notes on Configuration](#notes-on-configuration-⚙️)
- [Security & Privacy](#security--privacy-⚠️)
- [Contributing](#contributing--development-🤝)
- [License & Contact](#license--contact-🧾)

--

## Highlights ✨
- End-to-end encryption using `tweetnacl` (NaCl box) for peer-to-peer messages.
- Relay-side split-delivery and decoy injection to increase indistinguishability.
- Per-message TTL (self-destruct): sender-controlled expiry with server-side pruning.
- Real-time frontend removal via WebSocket `message_expired` events.
- Optional, client-only local agent: keyword alerts, quick-reply templates, and
  a "panic" persona for emergency fallback behavior.
- CSPRNG provenance auditing: server uses Python `secrets`, client uses Web Crypto.

## Repository Structure 📁
- `client/` — React + TypeScript (Vite): UI, WebSocket client, local agent,
  crypto helpers, and small dev utilities.
- `server/` — FastAPI relay with message store, split-delivery logic, decoy
  injector, and background sweeper to remove expired messages.
- `test/` — Integration and smoke tests used for local validation.

## Quick Start (local) 🚀
Start the backend relay, then the frontend dev server.

1) Start the backend relay

```bash
cd server
python -m venv .venv      # optional
# Windows
.venv\Scripts\activate
# macOS / Linux
# source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

2) Start the frontend

```bash
cd client
npm install
npm run dev
# build for production
npm run build
```

If you prefer Docker or another orchestrator, adapt the above commands to
your environment.

## Fonts & UI Styling 🎨
To make the UI look polished and readable, include a modern web font and set
global typography rules. Below are recommended fonts and snippets for quick
integration into the `client` app.

Recommended fonts
- Inter — modern, neutral UI font (great for interfaces)
- IBM Plex Sans — humanist sans-serif with good legibility
- Roboto — common and robust fallback

Add a Google Fonts link in `client/index.html` inside `<head>`:

```html
<!-- Example: Inter -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
```

Then set CSS in `client/src/index.css` (or your global stylesheet):

```css
:root {
  --font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
  --bg: #ffffff;
  --text: #111827;
}
html, body, #root {
  height: 100%;
}
body {
  margin: 0;
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
h1, h2, h3 { font-weight: 600; }

/* Small accessibility hint: allow users to scale type */
html { font-size: 16px; }
@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.001ms !important; } }
```

Notes
- Avoid embedding fonts inline into JS bundles; prefer link preconnect + stylesheet
  for better caching and smaller builds.
- If you need strict offline usage, vendor the font files and reference locally.

## Notes on Configuration ⚙️
- During development the frontend targets `http://localhost:8000` by default.
  Change `client/src/App.tsx` to point to a deployed relay instance for demos.
- Vite evaluates some code at build time — guard browser-only APIs (e.g.
  `atob`/`btoa`, `AudioContext`, `navigator.mediaDevices`) with runtime checks
  or provide Node fallbacks for build environments.

## Security & Privacy — Important ⚠️
- Prototype: this is research/demo code. Do NOT use with real sensitive
  production traffic without a security review and threat-modeling.
- Audit logs intentionally redact identifiers by storing only SHA-256 prefixes
  and annotate RNG provenance (e.g., "Web Crypto", "secrets.token_bytes").

## Contributing & Development 🤝
- Contributions welcome. Open an issue or submit a PR. Prefer small,
  well-scoped changes and include tests where appropriate.

## License & Contact 🧾
- MIT-style license (see LICENSE if present). For questions or help running
  the project, open an issue on the repository.

---

Enjoy exploring — and be careful with real secrets! 💡
