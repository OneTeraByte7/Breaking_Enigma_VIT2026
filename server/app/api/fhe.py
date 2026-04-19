from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.services.fhe import fhe_service

router = APIRouter()


@router.get("/demo", tags=["FHE"])
async def fhe_demo():
    """Demonstration endpoint: create a context, encrypt a few values,
    homomorphically add them, and decrypt the result (demo only).
    """
    try:
        # Initialize context (keeps secret key in-memory for demo)
        fhe_service.init_context()

        # Example plaintexts
        inputs = [1.0, 2.0, 3.0]

        enc = [fhe_service.encrypt_scalar(v) for v in inputs]
        summed_b64 = fhe_service.add_ciphertexts(enc)
        decrypted = fhe_service.decrypt_scalar(summed_b64)

        return JSONResponse({
            "inputs": inputs,
            "encrypted_inputs": enc,
            "summed_encrypted": summed_b64,
            "summed_decrypted": decrypted,
            "note": "Demo: server holds secret key; in real deployments secret handling differs."
        })
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
