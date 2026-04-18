"""
Qanonym – Steganography Utility

Embeds a queue ID (arbitrary string) into a JPEG/PNG image using
Least Significant Bit (LSB) steganography on the red channel.

Usage:
    embed_in_image(queue_id, input_image_path, output_image_path)
    extracted = extract_from_image(image_path)

Notes:
    - The image must be large enough to hold the payload.
    - Requires Pillow: pip install Pillow
    - For a 64-char queue ID: 64 chars × 8 bits = 512 pixels minimum.
    - The payload is framed with a 4-byte little-endian length prefix.
"""

import struct
from pathlib import Path

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

SENTINEL = b"QANM"          # 4-byte magic header
BITS_PER_CHANNEL = 1         # LSB only — minimal visual distortion


def _require_pil():
    if not PIL_AVAILABLE:
        raise RuntimeError(
            "Pillow is required for steganography. "
            "Install it with: pip install Pillow"
        )


def _str_to_bits(s: str) -> list[int]:
    bits = []
    for byte in s.encode("utf-8"):
        for i in range(7, -1, -1):
            bits.append((byte >> i) & 1)
    return bits


def _bits_to_bytes(bits: list[int]) -> bytes:
    result = bytearray()
    for i in range(0, len(bits), 8):
        byte = 0
        for b in bits[i:i + 8]:
            byte = (byte << 1) | b
        result.append(byte)
    return bytes(result)


def embed_in_image(queue_id: str, input_path: str, output_path: str) -> None:
    """
    Embed queue_id into the LSB of the red channel of input_path.
    Saves the result to output_path (PNG to avoid JPEG re-compression artifacts).
    """
    _require_pil()

    payload = SENTINEL + struct.pack("<I", len(queue_id)) + queue_id.encode("utf-8")
    bits = _str_to_bits(payload.decode("latin-1"))

    img = Image.open(input_path).convert("RGB")
    pixels = list(img.getdata())

    if len(bits) > len(pixels):
        raise ValueError(
            f"Image too small: need {len(bits)} pixels, have {len(pixels)}."
        )

    new_pixels = []
    for i, pixel in enumerate(pixels):
        if i < len(bits):
            r, g, b = pixel
            r = (r & 0xFE) | bits[i]   # Replace LSB of red channel
            new_pixels.append((r, g, b))
        else:
            new_pixels.append(pixel)

    out = Image.new("RGB", img.size)
    out.putdata(new_pixels)
    out.save(output_path, format="PNG")


def extract_from_image(image_path: str) -> str | None:
    """
    Extract a queue_id previously embedded by embed_in_image.
    Returns None if no valid payload is found.
    """
    _require_pil()

    img = Image.open(image_path).convert("RGB")
    pixels = list(img.getdata())

    # Extract bits from red channel LSBs
    bits = [(r & 1) for r, g, b in pixels]

    # Need at least (4 sentinel + 4 length) × 8 bits
    if len(bits) < 64:
        return None

    # Verify sentinel
    sentinel_bits = bits[:32]
    sentinel_bytes = _bits_to_bytes(sentinel_bits)
    if sentinel_bytes != SENTINEL:
        return None

    # Read 4-byte length
    length_bits = bits[32:64]
    length_bytes = _bits_to_bytes(length_bits)
    length = struct.unpack("<I", length_bytes)[0]

    # Sanity check
    if length > 1024:
        return None

    total_bits_needed = 64 + length * 8
    if len(bits) < total_bits_needed:
        return None

    # Read payload
    payload_bits = bits[64:total_bits_needed]
    payload_bytes = _bits_to_bytes(payload_bits)

    try:
        return payload_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return None