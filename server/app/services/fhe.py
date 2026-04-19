"""Simple FHE prototype helpers using TenSEAL (CKKS).

This module provides a minimal, server-side demo of homomorphic
aggregation using TenSEAL. It is intended as a prototype only — the
production integration requires careful key management and deployment
considerations.
"""
from __future__ import annotations

import base64
import logging
from typing import List, Optional

logger = logging.getLogger("qanonym.fhe")

try:
    import tenseal as ts
except Exception as e:  # pragma: no cover - optional dependency
    ts = None
    logger.debug("TenSEAL import failed: %s", e)


class FHEService:
    """Lightweight wrapper around TenSEAL context for CKKS scalar vectors.

    Notes:
    - Uses CKKS (approximate) scheme and encrypts scalar values as length-1
      CKKS vectors. This is suitable for demonstrating summation and mean.
    - The service keeps a context with secret key in memory for demo purposes.
      In a real deployment, secret keys should be handled with strict PKI/HE
      practices and not left in memory unnecessarily.
    """

    def __init__(self) -> None:
        self.context: Optional["ts.Context"] = None

    def ensure_available(self) -> None:
        if ts is None:
            raise RuntimeError("TenSEAL is not installed. Install 'tenseal' to use FHE features.")

    def init_context(self, poly_mod_degree: int = 8192, coeff_mod_bit_sizes=(60, 40, 40), global_scale: float = 2 ** 40) -> None:
        """Initialize a new TenSEAL CKKS context (includes secret key).

        This keeps the secret key in memory (for demo). For real deployments
        you'd separate encryption/public contexts from secret contexts.
        """
        self.ensure_available()
        if self.context is not None:
            return

        ctx = ts.context(ts.SCHEME_TYPE.CKKS, poly_mod_degree, -1, coeff_mod_bit_sizes)
        ctx.generate_galois_keys()
        try:
            ctx.generate_relin_keys()
        except Exception:
            # older TenSEAL builds may omit relin generation step
            pass
        ctx.global_scale = global_scale
        # Keep secret key in context for demo decrypts
        self.context = ctx
        logger.info("FHE context initialized (poly=%s)", poly_mod_degree)

    def encrypt_scalar(self, value: float) -> str:
        """Encrypt a single scalar (as CKKS vector) and return base64.

        Returns serialized ciphertext as base64 string.
        """
        self.ensure_available()
        if self.context is None:
            self.init_context()

        vec = ts.ckks_vector(self.context, [float(value)])
        raw = vec.serialize()
        return base64.b64encode(raw).decode("ascii")

    def add_ciphertexts(self, ciphertexts_b64: List[str]) -> str:
        """Homomorphically add a list of CKKS ciphertexts (base64) and return base64 sum."""
        self.ensure_available()
        if self.context is None:
            raise RuntimeError("FHE context not initialized")

        total = None
        for b64 in ciphertexts_b64:
            raw = base64.b64decode(b64)
            try:
                ct = ts.ckks_vector_from(self.context, raw)
            except Exception:
                # Fallback for TenSEAL builds where API differs
                ct = ts.CKKSVector.load(self.context, raw)

            if total is None:
                total = ct
            else:
                total += ct

        if total is None:
            raise ValueError("No ciphertexts provided")

        raw_sum = total.serialize()
        return base64.b64encode(raw_sum).decode("ascii")

    def decrypt_scalar(self, ciphertext_b64: str) -> float:
        """Decrypt a CKKS ciphertext (base64) and return the scalar (approx).

        Requires the context to contain the secret key.
        """
        self.ensure_available()
        if self.context is None:
            raise RuntimeError("FHE context not initialized")

        raw = base64.b64decode(ciphertext_b64)
        try:
            ct = ts.ckks_vector_from(self.context, raw)
        except Exception:
            ct = ts.CKKSVector.load(self.context, raw)

        try:
            vals = ct.decrypt()
        except Exception as e:
            # Provide clearer error if secret key is missing
            raise RuntimeError("Failed to decrypt ciphertext. Ensure the context contains the secret key.") from e

        if isinstance(vals, list) and len(vals) > 0:
            return float(vals[0])
        # Unexpected format
        raise RuntimeError("Decrypted value shape unexpected")


# Module-level singleton for simplicity
fhe_service = FHEService()
