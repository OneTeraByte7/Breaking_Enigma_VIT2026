# Qanonym Relay API Testing Guide

## Overview
Qanonym is a **metadata-resistant messenger relay** that stores and forwards encrypted blobs without ever seeing plaintext content. This guide covers all API endpoints with examples for testing in **Thunder Client** or **Postman**.

---

## Base URL
```
http://localhost:8000
```

---

## Quick Start: Complete Message Testing Workflow

### Prerequisites
- Server running: `python -m uvicorn app.main:app --reload`
- Thunder Client or Postman installed
- Base URL: `http://localhost:8000`

### Step-by-Step Message Flow

#### **Step 1: Create a Queue**
```
POST http://localhost:8000/api/v1/queues/create
```
- **Method:** POST
- **Body:** Empty (no JSON body)
- **Expected Status:** 201

**Response Example:**
```json
{
  "queue_id": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
  "created_at": "2026-04-18T11:01:49.599Z",
  "max_messages": 100
}
```

**⚠️ Save the `queue_id`** — you'll need it for all subsequent requests.

---

#### **Step 2: Check Queue Status**
```
GET http://localhost:8000/api/v1/queues/{queue_id}/status
```
- **Method:** GET
- **Replace `{queue_id}`** with the ID from Step 1
- **Expected Status:** 200

**Response Example:**
```json
{
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "real_message_count": 0,
  "total_message_count": 0,
  "created_at": "2026-04-18T11:01:49.599Z",
  "expired": false
}
```

---

#### **Step 3: Send First Message**
```
POST http://localhost:8000/api/v1/messages/{queue_id}
```
- **Method:** POST
- **Replace `{queue_id}`** with your queue ID
- **Body (JSON):**

```json
{
  "ciphertext": "aGVsbG8gd29ybGQ="
}
```

**Request Details:**
- `ciphertext`: Base64-encoded encrypted payload (can be any valid base64 string)
- `message_id` (optional): Unique message identifier. If omitted, server generates UUID.

**Expected Status:** 200

**Response Example:**
```json
{
  "status": "split_queued",
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "cipher_hash": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  "real_message_count": 1,
  "expiry_warning": false
}
```

**Note:** Messages are split into two parts (part 1 delayed, part 2 scheduled) for traffic analysis resistance.

---

#### **Step 4: Send Multiple Messages**
Test with different payloads to fill the queue.

**Message 2:**
```json
{
  "ciphertext": "c29tZSBjcnlwdG8gZGF0YQ==",
  "message_id": "msg-001"
}
```

**Message 3:**
```json
{
  "ciphertext": "YW5vdGhlciBlbmNyeXB0ZWQgYmxvYg==",
  "message_id": "msg-002"
}
```

**Message 4:**
```json
{
  "ciphertext": "ZWNobyBsYWJlbCBkYXRhIGZvciBzdGVnYQ==",
  "message_id": "msg-003"
}
```

Each should return status 200 with incrementing `real_message_count`.

---

#### **Step 5: Poll Messages (REST Fallback)**
```
GET http://localhost:8000/api/v1/messages/{queue_id}?limit=10
```
- **Method:** GET
- **Query Parameters:**
  - `limit` (optional): 1-100, default 20

**Expected Status:** 200

**Response Example:**
```json
{
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "message_count": 4,
  "messages": [
    "aGVsbG8gd29ybGQ=",
    "c29tZSBjcnlwdG8gZGF0YQ==",
    "YW5vdGhlciBlbmNyeXB0ZWQgYmxvYg==",
    "ZWNobyBsYWJlbCBkYXRhIGZvciBzdGVnYQ=="
  ]
}
```

---

#### **Step 6: Check Status After Messages**
```
GET http://localhost:8000/api/v1/queues/{queue_id}/status
```

**Response should show updated counts:**
```json
{
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "real_message_count": 4,
  "total_message_count": 8,
  "created_at": "2026-04-18T11:01:49.599Z",
  "expired": false
}
```

**Note:** `total_message_count` is 8 because of split delivery (2 parts per real message).

---

#### **Step 7: Verify Messages in Audit Log**
```
POST http://localhost:8000/api/v1/audit/verify
```
- **Method:** POST
- **Body (JSON):**

```json
{
  "ciphertext_b64": "aGVsbG8gd29ybGQ=",
  "queue_id": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"
}
```

**Expected Status:** 200

**Response Example:**
```json
{
  "found": true,
  "timestamp": "2026-04-18T11:01:50.123Z",
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "cipher_hash": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
}
```

This proves the relay handled this exact ciphertext without revealing content.

---

#### **Step 8: Get Relay Statistics**
```
GET http://localhost:8000/api/v1/stats
```
- **Method:** GET
- **Expected Status:** 200

**Response Example:**
```json
{
  "active_queues": 1,
  "total_messages_relayed": 4,
  "canary_status": "operational",
  "canary_last_updated": "2026-04-18T11:01:49.599Z",
  "recent_audit_entries": [
    {
      "timestamp": "2026-04-18T11:01:50.123Z",
      "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
      "cipher_hash": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
    }
  ]
}
```

---

#### **Step 9: Delete/Expire Queue**
```
DELETE http://localhost:8000/api/v1/queues/{queue_id}
```
- **Method:** DELETE
- **Expected Status:** 200

**Response Example:**
```json
{
  "status": "deleted",
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0"
}
```

After deletion, attempts to send messages to this queue will return **404 Queue not found**.

---

#### **Step 10: Verify Queue is Deleted**
```
GET http://localhost:8000/api/v1/queues/{queue_id}/status
```

**Expected Status:** 404

**Response:**
```json
{
  "detail": "Queue not found."
}
```

---

## Complete API Reference

### Health & Info Endpoints

#### Get Service Info
```
GET /
```
**Response:**
```json
{
  "service": "Qanonym Relay",
  "version": "1.0.0",
  "status": "operational",
  "note": "All stored data is encrypted ciphertext. No plaintext is ever processed."
}
```

---

#### Health Check
```
GET /health
```
**Response:**
```json
{
  "status": "ok",
  "active_queues": 5
}
```

---

### Queue Management

#### Create Queue
```
POST /api/v1/queues/create
```
- **Status Code:** 201
- **Body:** Empty
- **Response Fields:**
  - `queue_id`: 64-character hex string (random queue identifier)
  - `created_at`: ISO 8601 timestamp
  - `max_messages`: Maximum messages allowed per queue

---

#### Get Queue Status
```
GET /api/v1/queues/{queue_id}/status
```
- **Status Code:** 200 (or 404 if not found)
- **Response Fields:**
  - `queue_id_hash`: SHA-256 hash of queue ID (anonymized)
  - `real_message_count`: Actual messages sent
  - `total_message_count`: Total with decoy/split parts
  - `created_at`: Creation timestamp
  - `expired`: Boolean flag

---

#### Delete Queue
```
DELETE /api/v1/queues/{queue_id}
```
- **Status Code:** 200
- **Effect:** Marks queue as expired, notifies subscribers
- **Response Fields:**
  - `status`: "deleted"
  - `queue_id_hash`: Hashed queue ID

---

### Message Endpoints

#### Send Message
```
POST /api/v1/messages/{queue_id}
```
- **Status Code:** 200 (or 404/410 if queue invalid/full)
- **Body (JSON):**
  ```json
  {
    "ciphertext": "base64EncodedData",
    "message_id": "optional-uuid"
  }
  ```
- **Response Fields:**
  - `status`: "split_queued"
  - `queue_id_hash`: Hashed queue ID
  - `cipher_hash`: SHA-256 hash of ciphertext
  - `real_message_count`: Updated message count
  - `expiry_warning`: True if < 5 messages remaining

**Error Cases:**
- **400:** Invalid base64 ciphertext
- **404:** Queue not found or expired
- **410:** Queue reached message limit

---

#### Poll Messages
```
GET /api/v1/messages/{queue_id}?limit=20
```
- **Status Code:** 200 (or 404 if queue not found)
- **Query Parameters:**
  - `limit`: 1-100, default 20
- **Response Fields:**
  - `queue_id_hash`: Hashed queue ID
  - `message_count`: Number of messages returned
  - `messages`: Array of base64-encoded ciphertext blobs

**Note:** Messages are NOT deleted after polling. Use WebSocket for proper one-time delivery.

---

### WebSocket (Real-Time Delivery)

#### Subscribe to Queue
```
WS ws://localhost:8000/ws/{queue_id}
```

**Setup in Thunder Client:**
1. Switch protocol to WebSocket
2. URL: `ws://localhost:8000/ws/your-queue-id`
3. Connect
4. Type `subscribe your-queue-id` and press Enter

**Message Format (incoming):**
```json
{
  "type": "message",
  "ciphertext": "aGVsbG8gd29ybGQ="
}
```

**Message Format (queue expired):**
```json
{
  "type": "queue_expired",
  "message": "Queue has been marked as expired."
}
```

---

### Audit & Statistics

#### Get Statistics
```
GET /api/v1/stats
```
- **Status Code:** 200
- **Response Fields:**
  - `active_queues`: Count of non-expired queues
  - `total_messages_relayed`: Sum of all real messages
  - `canary_status`: "operational" | "triggered"
  - `canary_last_updated`: ISO 8601 timestamp
  - `recent_audit_entries`: Array of recent audit log hashes

---

#### Verify Message in Audit Log
```
POST /api/v1/audit/verify
```
- **Status Code:** 200
- **Body (JSON):**
  ```json
  {
    "ciphertext_b64": "aGVsbG8gd29ybGQ=",
    "queue_id": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"
  }
  ```
- **Response (Found):**
  ```json
  {
    "found": true,
    "timestamp": "2026-04-18T11:01:50.123Z",
    "queue_id_hash": "...",
    "cipher_hash": "..."
  }
  ```
- **Response (Not Found):**
  ```json
  {
    "found": false,
    "detail": "No matching entry in audit log."
  }
  ```

---

### Steganography (Image Embedding)

#### Embed Queue ID in Image
```
POST /api/v1/queues/{queue_id}/stego
```
- **Status Code:** 200 (or 501 if Pillow not installed)
- **Content-Type:** `multipart/form-data`
- **Form Field:** `file` (PNG or JPEG image)
- **Response:** Binary PNG with embedded queue ID in red-channel LSBs
- **Download:** Returned as attachment `share_this.png`

**Instructions:**
1. In Thunder Client: Select `multipart/form-data`
2. Add form field: `file` → select image file
3. Send POST request
4. Save the returned PNG

---

#### Extract Queue ID from Image
```
POST /api/v1/queues/stego/extract
```
- **Status Code:** 200 (or 404 if no payload found)
- **Content-Type:** `multipart/form-data`
- **Form Field:** `file` (PNG image with embedded queue ID)
- **Response (Success):**
  ```json
  {
    "queue_id": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"
  }
  ```
- **Response (No Payload):**
  ```json
  {
    "detail": "No Qanonym payload found in this image."
  }
```

---

## Complete Message Testing Sequence

### Test Data
Use these pre-encoded base64 strings for testing:

| Label | Base64 | Decodes To |
|-------|--------|-----------|
| Simple greeting | `aGVsbG8gd29ybGQ=` | "hello world" |
| Crypto data | `c29tZSBjcnlwdG8gZGF0YQ==` | "some crypto data" |
| Another blob | `YW5vdGhlciBlbmNyeXB0ZWQgYmxvYg==` | "another encrypted blob" |
| Echo label | `ZWNobyBsYWJlbCBkYXRhIGZvciBzdGVnYQ==` | "echo label data for stega" |
| Test message | `dGVzdCBtZXNzYWdlIGZvciBhdWRpdA==` | "test message for audit" |

---

### Complete Request/Response Examples

#### Create Queue
```http
POST /api/v1/queues/create HTTP/1.1
Host: localhost:8000
Content-Length: 0

HTTP/1.1 201 Created
content-type: application/json
{
  "queue_id": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
  "created_at": "2026-04-18T11:01:49.599Z",
  "max_messages": 100
}
```

#### Send Message 1
```http
POST /api/v1/messages/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0 HTTP/1.1
Host: localhost:8000
Content-Type: application/json

{
  "ciphertext": "aGVsbG8gd29ybGQ="
}

HTTP/1.1 200 OK
content-type: application/json
{
  "status": "split_queued",
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "cipher_hash": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  "real_message_count": 1,
  "expiry_warning": false
}
```

#### Send Message 2
```http
POST /api/v1/messages/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0 HTTP/1.1
Host: localhost:8000
Content-Type: application/json

{
  "ciphertext": "c29tZSBjcnlwdG8gZGF0YQ==",
  "message_id": "msg-001"
}

HTTP/1.1 200 OK
content-type: application/json
{
  "status": "split_queued",
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "cipher_hash": "da7a3cbfed5b7f3649a15ba0c90f72b8a6e60c8f36fd2f8b9e4c1d5a3f7b6e9c",
  "real_message_count": 2,
  "expiry_warning": false
}
```

#### Poll Messages
```http
GET /api/v1/messages/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0?limit=10 HTTP/1.1
Host: localhost:8000

HTTP/1.1 200 OK
content-type: application/json
{
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "message_count": 2,
  "messages": [
    "aGVsbG8gd29ybGQ=",
    "c29tZSBjcnlwdG8gZGF0YQ=="
  ]
}
```

#### Verify Audit Entry
```http
POST /api/v1/audit/verify HTTP/1.1
Host: localhost:8000
Content-Type: application/json

{
  "ciphertext_b64": "aGVsbG8gd29ybGQ=",
  "queue_id": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"
}

HTTP/1.1 200 OK
content-type: application/json
{
  "found": true,
  "timestamp": "2026-04-18T11:01:50.123Z",
  "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "cipher_hash": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
}
```

#### Get Stats
```http
GET /api/v1/stats HTTP/1.1
Host: localhost:8000

HTTP/1.1 200 OK
content-type: application/json
{
  "active_queues": 1,
  "total_messages_relayed": 2,
  "canary_status": "operational",
  "canary_last_updated": "2026-04-18T11:01:49.599Z",
  "recent_audit_entries": [
    {
      "timestamp": "2026-04-18T11:01:50.123Z",
      "queue_id_hash": "f1e8d4c5b6a7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
      "cipher_hash": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
    }
  ]
}
```

---

## Error Handling

### Common Error Responses

#### Invalid Base64
```json
{
  "detail": "Invalid base64 ciphertext."
}
```
**Status:** 400

---

#### Queue Not Found
```json
{
  "detail": "Queue not found or expired."
}
```
**Status:** 404

---

#### Queue Full (Reached Message Limit)
```json
{
  "detail": "Queue has reached its message limit and has been expired."
}
```
**Status:** 410

---

#### Resource Not Found
```json
{
  "detail": "Resource not found."
}
```
**Status:** 404

---

#### Server Error
```json
{
  "detail": "Internal server error."
}
```
**Status:** 500

---

## Interactive API Documentation

### Swagger UI
Open in browser: **http://localhost:8000/docs**
- Interactive endpoint explorer
- Try-it-out feature
- Request/response examples

### ReDoc
Open in browser: **http://localhost:8000/redoc**
- Beautiful API documentation
- Detailed schema definitions

### OpenAPI JSON
Access raw spec: **http://localhost:8000/openapi.json**

---

## Security Notes

⚠️ **Important Points:**

1. **No Plaintext:** The relay only handles base64-encoded ciphertexts. All content is opaque to the server.

2. **Hashed Audit Log:** Only SHA-256 hashes are stored. Original queue IDs and ciphertexts are never logged.

3. **Split Delivery:** Each message is split into 2 parts for traffic analysis resistance:
   - Part 1: Delayed 0.5-2 seconds
   - Part 2: Scheduled 2-5 seconds
   - This prevents correlation attacks

4. **Decoy Traffic:** Background service injects fake messages to obscure real traffic patterns.

5. **Queue Expiry:** Queues auto-delete after 100 messages or manual deletion.

6. **WebSocket Only:** For production, prefer WebSocket over HTTP polling for real-time delivery and proper cleanup.

---

## Configuration

Key environment variables (see `.env` or `env.example`):

```env
QUEUE_ID_BYTES=32              # 64-char hex queue IDs
MAX_MESSAGES_PER_QUEUE=100     # Queue expiry threshold
MAX_QUEUES_TOTAL=1000          # System-wide queue limit
SPLIT_DELAY_MIN=0.5            # Min delay for split part 1 (seconds)
SPLIT_DELAY_MAX=2.0            # Max delay for split part 1
SPLIT_SCHEDULE_MIN=2.0         # Min schedule for part 2
SPLIT_SCHEDULE_MAX=5.0         # Max schedule for part 2
AUDIT_LOG_PATH=audit.log       # Audit log file path
```

---

## Testing with Thunder Client (Step-by-Step)

### 1. Create New Request Collection
- Click **"Collections"** → **"+"** → Name it "Qanonym API"

### 2. Add Requests

**Request 1: Create Queue**
- Name: `Create Queue`
- Method: POST
- URL: `http://localhost:8000/api/v1/queues/create`
- Body: Empty
- Save response to variable: `{{queue_id}}`

**Request 2: Send Message**
- Name: `Send Message`
- Method: POST
- URL: `http://localhost:8000/api/v1/messages/{{queue_id}}`
- Body (JSON):
  ```json
  {
    "ciphertext": "aGVsbG8gd29ybGQ="
  }
  ```

**Request 3: Poll Messages**
- Name: `Poll Messages`
- Method: GET
- URL: `http://localhost:8000/api/v1/messages/{{queue_id}}?limit=10`

**Request 4: Get Stats**
- Name: `Get Stats`
- Method: GET
- URL: `http://localhost:8000/api/v1/stats`

**Request 5: Delete Queue**
- Name: `Delete Queue`
- Method: DELETE
- URL: `http://localhost:8000/api/v1/queues/{{queue_id}}`

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 404 on `/api/v1/*` | Server not running. Run `uvicorn app.main:app --reload` from `server/` directory |
| Invalid base64 | Ensure ciphertext is valid base64. Use online encoder: base64encode.org |
| Queue not found | Queue ID may be wrong or queue expired. Create a new queue. |
| Module not found errors | Install dependencies: `pip install -r requirements.txt` |
| Pillow not installed | For stego endpoints: `pip install Pillow` |
| Port 8000 in use | Change port: `uvicorn app.main:app --port 8001` |

---

## Summary

This API provides a secure, metadata-resistant relay for encrypted messages. Use this guide to:
- ✅ Create queues for anonymous communication
- ✅ Send encrypted messages
- ✅ Subscribe to real-time delivery
- ✅ Verify audit logs
- ✅ Embed queue IDs in images

All endpoints are tested and production-ready. For questions, check the `/docs` endpoint or review the pytest suite in `test/test_relay.py`.
