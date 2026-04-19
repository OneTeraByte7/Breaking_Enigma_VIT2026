import httpx
API='http://localhost:8000/api/v1'
qid='6bacb33af50f86b3c0d49e259f8114efd7bb232aa0d306319fddb17e77d02f73'
with httpx.Client() as c:
    r=c.get(f"{API}/messages/{qid}?limit=50")
    print(r.status_code)
    data=r.json()
    print('message_count', data.get('message_count'))
    for i,m in enumerate(data.get('messages',[])):
        print(i, m.get('type'), (m.get('ciphertext') or '')[:30], m.get('expires_at'), m.get('_is_decoy'))
