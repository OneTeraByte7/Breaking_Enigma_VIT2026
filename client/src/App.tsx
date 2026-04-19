import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, Lock, EyeOff, Terminal, Activity, X, QrCode, Send, Image as ImageIcon, Trash2, Github, Mic } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { generateKeyPair, encryptMessage, decryptMessage, formatCiphertextForRelay, decryptMessageFromRelay } from './lib/crypto';

type Message = {
  id: string;
  sender: 'me' | 'them';
  text?: string;
  image?: string;
  voice?: string;
  timestamp: number;
  isDecoy?: boolean;
  urgent?: boolean;
};

type View = 'LANDING' | 'MESSENGER' | 'DASHBOARD';

// Get API base URL dynamically. Defaults to deployed backend unless running local dev server.
const DEPLOYED_BACKEND = 'https://breaking-enigma-vit26.onrender.com';
const getAPIBase = () => {
  // Local development (vite / react dev server)
  if (window.location.port === '3000' || window.location.port === '5173') {
    return 'http://localhost:8000';
  }
  // If running on file:// or in CI preview, prefer deployed backend
  if (!window.location.hostname || window.location.hostname === '127.0.0.1') {
    return DEPLOYED_BACKEND;
  }
  // Default: use deployed backend to communicate with relay
  return DEPLOYED_BACKEND;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

// Return a URL-safe base64 id from browser CSPRNG
const cryptoRandomId = (byteLen = 12): string => {
  const arr = crypto.getRandomValues(new Uint8Array(byteLen));
  // bytesToBase64 expects a Uint8Array
  const b64 = bytesToBase64(arr);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Return a uniformly distributed integer in [0, max)
const cryptoRandomInt = (max: number): number => {
  if (max <= 0) return 0;
  // Use 32-bit unsigned to have enough range
  const uint32 = crypto.getRandomValues(new Uint32Array(1))[0];
  return Math.floor((uint32 / 0xffffffff) * max) % max;
};

// Generate a small dummy base64 blob using Web Crypto (for dev decoy testing)
const generateDummyBlob = (size = 128) => {
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return bytesToBase64(arr);
};

const PANIC_PASSPHRASE_STORAGE_KEY = 'velora.panic.passphrase';

const PANIC_AUTO_REPLIES = [
  'Done. I will bring the printed notes tomorrow.',
  'Lets finalize section two after lunch.',
  'Shared the worksheet draft in the class drive.',
  'Sure, we can review the timeline in the evening.',
  'Okay, adding this to our meeting checklist.'
];

const QUICK_REPLY_TEMPLATES = [
  "Reinforcements en route",
  "Hold position — awaiting orders",
  "Move to cover and report coordinates",
  "Affirmative, standing by",
];

const createPanicSeedMessages = (): Message[] => {
  const now = Date.now();
  return [
    {
      id: 'panic-seed-1',
      sender: 'them',
      text: 'Reminder: submit the project abstract by 5 PM.',
      timestamp: now - 1000 * 60 * 16,
    },
    {
      id: 'panic-seed-2',
      sender: 'me',
      text: 'Got it. I will upload the final PDF before 4:30.',
      timestamp: now - 1000 * 60 * 12,
    },
    {
      id: 'panic-seed-3',
      sender: 'them',
      text: 'Perfect. Also keep 2-3 slides for quick demo.',
      timestamp: now - 1000 * 60 * 9,
    },
  ];
};

export default function App() {
  const [view, setView] = useState<View>('LANDING');
  const [queueId, setQueueId] = useState<string>('');
  const [keyPair] = useState(() => generateKeyPair());
  const keyPairRef = useRef(keyPair); // Stable reference to our keypair
  const sentOwnPKRef = useRef(false); // Track if we've already seen our own PK sent back
  const [sessionToken] = useState(() => cryptoRandomId(12));
  const [theirPublicKey, setTheirPublicKey] = useState<Uint8Array | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [wsRetryTick, setWsRetryTick] = useState(0);
  const [hasJoinedPeer, setHasJoinedPeer] = useState<boolean>(false);
  const [panicMode, setPanicMode] = useState(false);
  const [panicPassphrase, setPanicPassphrase] = useState<string>(() => {
    try {
      return window.localStorage.getItem(PANIC_PASSPHRASE_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [panicSetupOpen, setPanicSetupOpen] = useState(false);
  const [panicSetupValue, setPanicSetupValue] = useState('');
  const [panicSetupConfirm, setPanicSetupConfirm] = useState('');
  const [panicSetupError, setPanicSetupError] = useState('');
  const [panicUnlockInput, setPanicUnlockInput] = useState('');
  const [panicUnlockError, setPanicUnlockError] = useState('');
  const [panicDraft, setPanicDraft] = useState('');
  const [panicMessages, setPanicMessages] = useState<Message[]>(() => createPanicSeedMessages());
  const wsRef = useRef<WebSocket | null>(null);
  const [selfDestructEnabled, setSelfDestructEnabled] = useState(false);
  const [selfDestructSeconds, setSelfDestructSeconds] = useState<number>(60);
  const [chatUrgent, setChatUrgent] = useState(false);
  const [agentEnabled, setAgentEnabled] = useState<boolean>(() => {
    try { return window.localStorage.getItem('velora.agent.enabled') !== 'false'; } catch { return true; }
  });
  const [agentSensitivity, setAgentSensitivity] = useState<number>(() => {
    try { return Number(window.localStorage.getItem('velora.agent.sensitivity') || '3'); } catch { return 3; }
  });
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioUnlockedRef = useRef<boolean>(false);

  // Ensure agentEnabled persisted when toggled
  const toggleAgentEnabled = (next?: boolean) => {
    const val = typeof next === 'boolean' ? next : !agentEnabled;
    setAgentEnabled(val);
    try { window.localStorage.setItem('velora.agent.enabled', val ? 'true' : 'false'); } catch {}
  };
  
  const tpkRef = useRef<Uint8Array | null>(null); // Ref for theirPublicKey to use in WS callbacks
  const tpkSetter = (pk: Uint8Array | null) => {
    tpkRef.current = pk;
    setTheirPublicKey(pk);
    // Unlock messenger view for both peers once a valid peer key is seen.
    setHasJoinedPeer(Boolean(pk));
  };
  const [stats, setStats] = useState<any>(null);
  const [auditLog, setAuditLog] = useState<string>('');
  
  // Message parts reassembly buffer
  const partsBufferRef = useRef<{ [messageId: string]: { [index: number]: string } }>({});
  
  // Voice note recording state
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  const scrollRef = useRef<HTMLDivElement>(null);

  const postCiphertextToRelay = async (targetQueueId: string, ciphertext: string, messageId?: string): Promise<void> => {
    const body: any = { ciphertext };
    if (messageId) body.message_id = messageId;
    if (selfDestructEnabled && typeof selfDestructSeconds === 'number' && selfDestructSeconds > 0) {
      body.self_destruct_seconds = selfDestructSeconds;
    }

    const res = await fetch(`${getAPIBase()}/api/v1/messages/${targetQueueId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const details = await res.text().catch(() => res.statusText);
      throw new Error(`Relay post failed (${res.status}): ${details}`);
    }
  };

  const persistPanicPassphrase = (nextPassphrase: string) => {
    setPanicPassphrase(nextPassphrase);
    try {
      window.localStorage.setItem(PANIC_PASSPHRASE_STORAGE_KEY, nextPassphrase);
    } catch {
      // Ignore storage failures; panic mode will still work for this session.
    }
  };

  const resetPanicPersonaForNewSession = () => {
    setPanicMode(false);
    setPanicSetupOpen(false);
    setPanicSetupValue('');
    setPanicSetupConfirm('');
    setPanicSetupError('');
    setPanicUnlockInput('');
    setPanicUnlockError('');
    setPanicDraft('');
    setPanicMessages(createPanicSeedMessages());
    setPanicPassphrase('');
    try {
      window.localStorage.removeItem(PANIC_PASSPHRASE_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
  };

  const endCurrentSession = () => {
    setView('LANDING');
    setQueueId('');
    setMessages([]);
    tpkSetter(null);
    setHasJoinedPeer(false);
    resetPanicPersonaForNewSession();
  };

  const activatePanicMode = () => {
    if (panicMode) return;

    if (!panicPassphrase) {
      setPanicSetupOpen(true);
      return;
    }

    setPanicUnlockInput('');
    setPanicUnlockError('');
    setPanicMode(true);
  };

  const savePanicSetup = () => {
    const pass = panicSetupValue.trim();
    const confirm = panicSetupConfirm.trim();

    if (pass.length < 4) {
      setPanicSetupError('Passphrase must be at least 4 characters.');
      return;
    }

    if (pass !== confirm) {
      setPanicSetupError('Passphrase and confirmation do not match.');
      return;
    }

    persistPanicPassphrase(pass);
    setPanicSetupOpen(false);
    setPanicSetupValue('');
    setPanicSetupConfirm('');
    setPanicSetupError('');
    setPanicUnlockInput('');
    setPanicUnlockError('');
    setPanicMode(true);
  };

  const unlockPanicMode = () => {
    if (!panicPassphrase) {
      setPanicUnlockError('No passphrase configured. Set one first.');
      return;
    }

    if (panicUnlockInput.trim() !== panicPassphrase) {
      setPanicUnlockError('Incorrect passphrase.');
      return;
    }

    setPanicMode(false);
    setPanicUnlockInput('');
    setPanicUnlockError('');
  };

  const sendPanicMessage = () => {
    const text = panicDraft.trim();
    if (!text) return;

    setPanicMessages((prev) => [
      ...prev,
      {
        id: `panic-${Date.now()}-${cryptoRandomId(6)}`,
        sender: 'me',
        text,
        timestamp: Date.now(),
      },
    ]);
    setPanicDraft('');

    const autoReply = PANIC_AUTO_REPLIES[cryptoRandomInt(PANIC_AUTO_REPLIES.length)];
    window.setTimeout(() => {
      setPanicMessages((prev) => [
        ...prev,
        {
          id: `panic-reply-${Date.now()}-${cryptoRandomId(6)}`,
          sender: 'them',
          text: autoReply,
          timestamp: Date.now(),
        },
      ]);
    }, 500 + cryptoRandomInt(1000));
  };

  // Step 2: Queue Gen
  const createNewQueue = async () => {
    try {
      const res = await fetch(`${getAPIBase()}/api/v1/queues/create`, {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      setQueueId(data.queue_id);
      setMessages([]);
      tpkSetter(null);
      setHasJoinedPeer(false);
    } catch (e) {
      console.error('Failed to create queue:', e);
      // Fallback to local generation
      const id = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      setQueueId(id);
      setMessages([]);
      tpkSetter(null);
      setHasJoinedPeer(false);
    }
  };

  const purgeCurrentSession = async () => {
    // If we have a peer connected, signal them to purge as well
    if (ws && tpkRef.current) {
      const encrypted = encryptMessage(JSON.stringify({ type: 'purge', sid: sessionToken }), tpkRef.current, keyPair.secretKey);
      const ciphertext = formatCiphertextForRelay(encrypted);
      await postCiphertextToRelay(queueId, ciphertext).catch(console.error);
    }
    
    // Clear local state
    setMessages([]);
    tpkSetter(null);
    resetPanicPersonaForNewSession();
    // Create a new queue
    createNewQueue();
  };

  useEffect(() => {
    if (view === 'DASHBOARD') {
      const fetchStats = async () => {
        try {
          const res = await fetch(`${getAPIBase()}/api/v1/stats`);
          const data = await res.json();
          setStats({
            activeQueues: data.active_queues,
            messageCount: data.total_messages_relayed,
            realMessages: data.total_messages_relayed,
            decoyMessages: 0
          });
          
          const auditLines = data.recent_audit_entries
            .map((entry: any) => `${entry.timestamp},${entry.queue_id_hash},${entry.cipher_hash}`)
            .join('\n');
          setAuditLog(`# HASH(QUEUE_ID) | HASH(BLOB) | TIMESTAMP\n${auditLines}`);
        } catch (e) {
          console.error(e);
        }
      };
      fetchStats();
      const interval = setInterval(fetchStats, 3000);
      return () => clearInterval(interval);
    }
  }, [view]);

  // WebRTC logic helpers
  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.onstart = () => setIsRecording(true);
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      mediaRecorder.onstop = async () => {
        setIsRecording(false);
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = async (e) => {
          const base64 = e.target?.result as string;
          if (ws && theirPublicKey) {
              const mid = cryptoRandomId(9);
            const encrypted = encryptMessage(JSON.stringify({ voice: base64, sid: sessionToken, mid }), theirPublicKey, keyPair.secretKey);
            const ciphertext = formatCiphertextForRelay(encrypted);

            try {
              await postCiphertextToRelay(queueId, ciphertext, mid);
              setMessages((prev: Message[]) => [...prev, {
                id: mid,
                sender: 'me',
                voice: base64,
                timestamp: Date.now()
              }]);
            } catch (err) {
              console.error('[Voice] Failed to relay recording:', err);
              alert('Voice note could not be delivered. Try a shorter recording.');
            }
          }
        };
        reader.readAsDataURL(audioBlob);
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
    } catch (e) {
      console.error('Error accessing microphone:', e);
      alert('Unable to access microphone. Please check permissions.');
    }
  };

  const stopVoiceRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (view !== 'MESSENGER') return;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        activatePanicMode();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view, panicMode, panicPassphrase, panicSetupOpen]);

  useEffect(() => {
    if (queueId && view === 'MESSENGER') {
      // Connect if: we created our own queue OR we joined a peer's queue
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        return;
      }
      
      let closedByCleanup = false;
      let retryTimer: number | undefined;
      
      console.log('[WS] Effect triggered - attempting connection. queueId:', queueId, 'view:', view, 'hasJoinedPeer:', hasJoinedPeer);
      
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // In development, backend WebSocket is on port 8000
      let wsHost = window.location.host;
      if (window.location.port === '3000' || window.location.port === '5173') {
        wsHost = 'localhost:8000';
      } else {
        // For deployed frontend, point WS to deployed backend host
        try {
          const url = new URL(DEPLOYED_BACKEND);
          wsHost = url.host;
        } catch (e) {
          // fallback to current host
        }
      }
      const wsUrl = `${protocol}//${wsHost}/ws/${queueId}`;
      
      console.log('[WS] Attempting to connect to:', wsUrl);
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      
      socket.onopen = async () => {
        console.log('[WS] Connected to queue:', queueId);
        wsRef.current = socket;
        setWs(socket);
        
        // Handshake: Send our public key as base64
        const sendPublicKey = async () => {
          const pkBase64 = bytesToBase64(keyPair.publicKey);
          console.log('[WS] Sending public key handshake, length:', pkBase64.length, 'to queue:', queueId);
          try {
            await fetch(`${getAPIBase()}/api/v1/messages/${queueId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ciphertext: pkBase64 })
            });
            console.log('[WS] Public key sent successfully to queue:', queueId);
          } catch (e) {
            console.error('[WS] Error sending public key:', e);
          }
        };

        // Send once; buffered delivery lets late-joining peers still receive it.
        await sendPublicKey();

        // Dev-only: log protected-queue notice and enqueue a small dummy decoy blob
        try {
          const isDev = window.location.hostname === 'localhost' || window.location.port === '3000' || window.location.port === '5173';
          if (isDev) {
            try {
              const enc = new TextEncoder();
              const qdigest = await crypto.subtle.digest('SHA-256', enc.encode(queueId || ''));
              const qhex = Array.from(new Uint8Array(qdigest)).map(b => b.toString(16).padStart(2, '0')).join('');
              console.info('[QUEUE] Protected (dev)', { sha256: qhex.slice(0, 12), e2ee: true, rng: 'Web Crypto' });
            } catch (e) {
              console.info('[QUEUE] Protected (dev) — unable to compute fingerprint', e);
            }

            // Send a small dummy blob as a decoy into the same queue to demonstrate traffic
            const dummy = generateDummyBlob(128);
            try {
              const r = await fetch(`${getAPIBase()}/api/v1/messages/${queueId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ciphertext: dummy })
              });
              if (r.ok) {
                const j = await r.json();
                console.info('[QUEUE] Dummy decoy enqueued', { queue_hash: j.queue_id_hash?.slice(0,12), cipher_hash: j.cipher_hash?.slice(0,12) });
              } else {
                console.warn('[QUEUE] Dummy decoy enqueue failed', r.status);
              }
            } catch (e) {
              console.warn('[QUEUE] Dummy decoy enqueue error', e);
            }
          }
        } catch (e) {
          /* swallow dev-only errors */
        }
      };

      socket.onmessage = async (event) => {
        console.log('[WS] Message received:', event.data);
        const payload = JSON.parse(event.data);

        if (payload.type === 'message_expired') {
          const mid = payload.message_id;
          if (mid) {
            setMessages((prev: Message[]) => prev.filter(m => m.id !== mid));
          }
          return;
        }

        if (payload.type === 'expiry') {
          endCurrentSession();
          return;
        }
        
        // Handle split delivery parts
        if (payload.type === 'part') {
          const { message_id, part_index, total_parts, ciphertext } = payload;
          console.log(`[WS] Received part ${part_index}/${total_parts} for message ${message_id}`);
          
          // Initialize buffer for this message if needed
          if (!partsBufferRef.current[message_id]) {
            partsBufferRef.current[message_id] = {};
          }
          
          // Store this part
          partsBufferRef.current[message_id][part_index] = ciphertext;
          
          // Check if we have all parts
          if (Object.keys(partsBufferRef.current[message_id]).length === total_parts) {
            // Reassemble the message
            try {
              // Decode each part from base64 to bytes
              const parts: Uint8Array[] = [];
              for (let i = 0; i < total_parts; i++) {
                const partB64 = partsBufferRef.current[message_id][i];
                const partBytes = Uint8Array.from(atob(partB64), c => c.charCodeAt(0));
                parts.push(partBytes);
              }
              
              // Concatenate all parts
              const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
              const combined = new Uint8Array(totalLength);
              let offset = 0;
              for (const part of parts) {
                combined.set(part, offset);
                offset += part.length;
              }
              
              // Encode back to base64 for processing
              const ciphertextB64 = bytesToBase64(combined);
              const data = ciphertextB64;
              console.log('[WS] Reassembled message length:', combined.length, 'base64 length:', data.length);
              
              // Case A: Check if it's a public key (32 bytes)
              try {
                const decoded = Uint8Array.from(atob(data), c => c.charCodeAt(0));
                console.log('[WS] Decoded reassembled message length:', decoded.length);
                
                // Log the first few bytes for debugging
                const myPKStart = Array.from(keyPairRef.current.publicKey.slice(0, 4));
                const receivedStart = Array.from(decoded.slice(0, 4));
                console.log('[WS] My PK first 4 bytes:', myPKStart);
                console.log('[WS] Received first 4 bytes:', receivedStart);
                
                // Log the actual bytes for debugging
                const myKeyHex = Array.from(keyPairRef.current.publicKey.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
                const receivedHex = Array.from(decoded.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
                console.log('[WS] Comparing keys - My:', myKeyHex, 'Received:', receivedHex, 'Match:', myKeyHex === receivedHex);
                
                // CRITICAL: Ignore our own public key being broadcast back to us (only once)
                const isMine = decoded.length === keyPairRef.current.publicKey.length && 
                               decoded.every((v, i) => v === keyPairRef.current.publicKey[i]);
                if (isMine) {
                  if (!sentOwnPKRef.current) {
                    console.log('[WS] Ignoring our own public key from reassembly (first occurrence)');
                    sentOwnPKRef.current = true;
                  }
                  delete partsBufferRef.current[message_id];
                  return;  // Skip processing our own key
                }
                
                // Now check if it's a peer's public key (only if it's NOT ours)
                if (decoded.length === 32) {
                  // It's a peer's public key
                  console.log('[WS] Received public key from peer (split reassembly), first 4 bytes:', Array.from(decoded.slice(0, 4)));
                  if (!tpkRef.current || !tpkRef.current.every((v: number, i: number) => v === decoded[i])) {
                    console.log('[WS] Setting peer public key from reassembled message, first 4 bytes:', Array.from(decoded.slice(0, 4)));
                    tpkSetter(decoded);
                  } else {
                    console.log('[WS] Already have this peer public key');
                  }
                  delete partsBufferRef.current[message_id];
                  return;
                }
              } catch(e) {
                console.log('[WS] Error decoding reassembled message as public key:', e);
              }
              
              // Case B: It's an encrypted message (nonce + box combined)
              const currentPK = tpkRef.current;
              if (currentPK) {
                const decrypted = decryptMessageFromRelay(data, currentPK, keyPair.secretKey);
                if (decrypted) {
                  try {
                    const parsed = JSON.parse(decrypted);
                    // CRITICAL: Ignore messages sent by ourselves that were broadcast back
                    // AND deduplicate by message ID (mid)
                    if (parsed.sid !== sessionToken) {
                      handleIncomingDecrypted(parsed, currentPK);
                    }
                  } catch (e) {}
                }
              }
              
              // Clean up buffer
              delete partsBufferRef.current[message_id];
            } catch (e) {
              console.error('[WS] Error reassembling parts:', e);
              delete partsBufferRef.current[message_id];
            }
          }
          return;
        }
        
        // Handle non-split messages (type: "message")
        if (payload.type === 'message') {
          const data = payload.ciphertext;
          console.log('[WS] Processing message, data type:', typeof data);
          
          if (!data || typeof data !== 'string') return;
          
          // Case A: Check if it's a public key (32 bytes)
          try {
            const decoded = Uint8Array.from(atob(data), c => c.charCodeAt(0));
            console.log('[WS] Decoded message length:', decoded.length);
            
            // Log the first few bytes for debugging
            const myPKStart = Array.from(keyPairRef.current.publicKey.slice(0, 4));
            const receivedStart = Array.from(decoded.slice(0, 4));
            console.log('[WS] My PK first 4 bytes:', myPKStart);
            console.log('[WS] Received first 4 bytes:', receivedStart);
            
            // CRITICAL: Ignore our own public key being broadcast back to us
            const isMine = decoded.length === keyPairRef.current.publicKey.length && 
                           decoded.every((v, i) => v === keyPairRef.current.publicKey[i]);
            if (isMine) {
              console.log('[WS] Ignoring our own public key');
              return;
            }

            if (decoded.length === 32) {
              // It's a public key
              console.log('[WS] Received 32-byte public key from peer (non-split)');
              if (!tpkRef.current || !tpkRef.current.every((v: number, i: number) => v === decoded[i])) {
                console.log('[WS] Setting peer public key from non-split message, first 4 bytes:', Array.from(decoded.slice(0, 4)));
                tpkSetter(decoded);
              } else {
                console.log('[WS] Already have this peer public key');
              }
              return;
            }
          } catch(e) {
            console.log('[WS] Error decoding as public key:', e);
          }
          
          // Case B: It's an encrypted message (nonce + box combined)
          const currentPK = tpkRef.current;
          if (currentPK) {
            const decrypted = decryptMessageFromRelay(data, currentPK, keyPair.secretKey);
            if (decrypted) {
              try {
                const parsed = JSON.parse(decrypted);
                // CRITICAL: Ignore messages sent by ourselves that were broadcast back
                // AND deduplicate by message ID (mid)
                if (parsed.sid !== sessionToken) {
                  handleIncomingDecrypted(parsed, currentPK);
                }
              } catch (e) {}
            }
          }
        }
      };

      socket.onclose = () => {
        console.log('[WS] Connection closed for queue:', queueId);
        if (closedByCleanup) return;
        if (wsRef.current === socket) {
          wsRef.current = null;
          setWs(null);
          // Retry after a short delay to recover from transient socket drops.
          retryTimer = window.setTimeout(() => {
            setWsRetryTick((prev) => prev + 1);
          }, 1200);
        }
      };

      socket.onerror = (error: Event) => {
        console.error('[WS] WebSocket error for queue:', queueId, error);
        if (wsRef.current === socket) {
          wsRef.current = null;
          setWs(null);
        }
      };
      
      return () => {
        closedByCleanup = true;
        if (retryTimer !== undefined) {
          window.clearTimeout(retryTimer);
        }
        if (wsRef.current === socket) {
          wsRef.current = null;
          setWs(null);
        }
        // Detach handlers so an old socket close doesn't clobber the active socket state.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      };
    }
  }, [queueId, view, keyPair.publicKey, keyPair.secretKey, wsRetryTick]);

  const handleIncomingDecrypted = async (parsed: any, currentPK: Uint8Array) => {
    if (parsed.type === 'purge') {
      // Remote peer purged the session
      setMessages([]);
      tpkSetter(null);
      resetPanicPersonaForNewSession();
    }
    else {
      // Regular Message - Deduplicate by mid
      // Keyword / urgent detection (local-only)
      const keywords = [
        /\b(enemy|platoon|reinforcements|support|attack|ambush|urgent|reinforce|hostile)\b/i,
        /\b(military|vehicle|tank|armored|artillery)\b/i
      ];

      const isUrgent = isUrgentText(parsed.text) || false;

      if (isUrgent) {
        // mark chat as urgent for UI and play a short alert tone (opt-in)
        setChatUrgent(true);
        if (agentEnabled) {
          try {
            playAlertTone();
          } catch {}
        }
      }

      setMessages((prev: Message[]) => {
        if (parsed.mid && prev.some((m: Message) => m.id === parsed.mid)) return prev;
        return [...prev, {
          id: parsed.mid || cryptoRandomId(9),
          sender: 'them',
          text: parsed.text,
          image: parsed.image,
          voice: parsed.voice,
          timestamp: Date.now(),
          urgent: isUrgent,
        }];
      });
    }
  };

  // Play a short alert tone locally (WebAudio) — no network involved
  const playAlertTone = () => {
    try {
      // Ensure we have an initialized AudioContext (user gesture may be required)
      const ctx = audioCtxRef.current || new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended' && !audioUnlockedRef.current) {
        // Try to resume; may still require a user gesture in some browsers
        ctx.resume().then(() => { audioUnlockedRef.current = true; }).catch(() => {});
      }
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(ctx.destination);
      const now = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.25, now + 0.01);
      o.start(now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      o.stop(now + 0.36);
    } catch (e) {
      // Fallback: try simple beep via new Audio() using a tiny data URI
      try {
        const ctxAudio = (window as any).Audio;
        if (ctxAudio) new Audio().play();
      } catch {}
    }
  };

  // Try to pre-initialize AudioContext on first user gesture so alerts can play
  useEffect(() => {
    const initAudio = async () => {
      try {
        if (!audioCtxRef.current) {
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          audioCtxRef.current = ctx;
          if (ctx.state === 'suspended') {
            await ctx.resume();
          }
          audioUnlockedRef.current = true;
        }
      } catch {}
    };
    const one = () => { initAudio(); window.removeEventListener('pointerdown', one); window.removeEventListener('keydown', one); };
    window.addEventListener('pointerdown', one);
    window.addEventListener('keydown', one);
    return () => { window.removeEventListener('pointerdown', one); window.removeEventListener('keydown', one); };
  }, []);

  // Normalize text for matching: lowercase, remove diacritics, strip punctuation
  const normalizeText = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // Fast Levenshtein distance (iterative, suitable for short tokens)
  const levenshtein = (a: string, b: string) => {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const v0 = new Array(n + 1).fill(0).map((_, i) => i);
    const v1 = new Array(n + 1).fill(0);
    for (let i = 0; i < m; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < n; j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (let k = 0; k <= n; k++) v0[k] = v1[k];
    }
    return v1[n];
  };

  // Heuristic fuzzy match — allow edits based on sensitivity (min 1)
  const fuzzyMatch = (token: string, keyword: string) => {
    // sensitivity 1..5 scales allowed edits (higher -> more permissive)
    const sensitivityFactor = Math.max(1, Math.min(5, agentSensitivity));
    const maxEdits = Math.max(1, Math.floor(keyword.length * 0.12 * sensitivityFactor));
    return levenshtein(token, keyword) <= maxEdits;
  };

  // Comprehensive urgent-text heuristic
  const isUrgentText = (raw: string | undefined) => {
    if (!raw) return false;
    const s = normalizeText(raw);
    if (!s) return false;

    // explicit phrase patterns
    const phrases = [
      'need support',
      'under attack',
      'enemy platoon',
      'request support',
      'reinforcements en route',
      'call for fire',
      'sos'
    ];
    for (const p of phrases) if (s.includes(p)) {
      // fingerprint and log non-sensitive evidence (sha256 prefix)
      (async () => {
        try {
          const enc = new TextEncoder();
          const digest = await crypto.subtle.digest('SHA-256', enc.encode(raw || ''));
          const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
          console.info('[AI] Phrase match', { sha256: hex.slice(0, 12), phrase: p });
        } catch (e) { /* noop */ }
      })();
      return true;
    }

    // grid coordinate pattern (e.g., "grid 7-alpha" or "grid 7 alpha")
    if (/grid\s*\d+[-\s]*[a-z]+/.test(raw.toLowerCase())) return true;

    // token-level checks with keywords + fuzzy
    const keywords = [
      'enemy','platoon','reinforcements','support','attack','ambush','urgent','reinforce','hostile',
      'military','vehicle','tank','armored','artillery','asap','immediately','help','evacuate','sos'
    ];

    const tokens = s.split(' ').filter(Boolean);
    // exact token matches
    for (const t of tokens) {
      if (keywords.includes(t)) {
        (async () => {
          try {
            const enc = new TextEncoder();
            const digest = await crypto.subtle.digest('SHA-256', enc.encode(raw || ''));
            const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
            console.info('[AI] Keyword exact match', { sha256: hex.slice(0, 12), token: t });
          } catch (e) { /* noop */ }
        })();
        return true;
      }
    }
    // fuzzy matches (log first few)
    for (const t of tokens) {
      for (const k of keywords) {
        if (fuzzyMatch(t, k)) {
          (async () => {
            try {
              const enc = new TextEncoder();
              const digest = await crypto.subtle.digest('SHA-256', enc.encode(raw || ''));
              const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
              console.info('[AI] Keyword fuzzy match', { sha256: hex.slice(0, 12), token: t, keyword: k });
            } catch (e) { /* noop */ }
          })();
          return true;
        }
      }
    }

    // punctuation/format urgency: many exclamations or all-caps proportion
    const exclamations = (raw.match(/!/g) || []).length;
    if (exclamations >= 2) {
      (async () => {
        try {
          const enc = new TextEncoder();
          const digest = await crypto.subtle.digest('SHA-256', enc.encode(raw || ''));
          const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
          console.info('[AI] Exclamation heuristic', { sha256: hex.slice(0, 12), exclamations });
        } catch (e) { /* noop */ }
      })();
      return true;
    }
    const letters = (raw.match(/[A-Za-z]/g) || []).length;
    const uppers = (raw.match(/[A-Z]/g) || []).length;
    if (letters > 6 && uppers / letters > 0.6) {
      (async () => {
        try {
          const enc = new TextEncoder();
          const digest = await crypto.subtle.digest('SHA-256', enc.encode(raw || ''));
          const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
          console.info('[AI] Uppercase heuristic', { sha256: hex.slice(0, 12), letters, uppers });
        } catch (e) { /* noop */ }
      })();
      return true;
    }

    // no heuristics triggered — do not log raw content for privacy
    return false;
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, panicMessages, panicMode]);

  const sendMessage = async () => {
    if (!inputText.trim() || !ws || !theirPublicKey) return;

    const mid = cryptoRandomId(9);
    const msg = { text: inputText, timestamp: Date.now(), sid: sessionToken, mid };
    const encrypted = encryptMessage(JSON.stringify(msg), theirPublicKey, keyPair.secretKey);
    const ciphertext = formatCiphertextForRelay(encrypted);
    
    try {
      await postCiphertextToRelay(queueId, ciphertext, mid);
      setMessages((prev: Message[]) => [...prev, {
        id: mid,
        sender: 'me',
        text: inputText,
        timestamp: Date.now()
      }]);
      setInputText('');
    } catch (err) {
      console.error('[Text] Failed to relay message:', err);
      alert('Message could not be delivered. Please retry.');
    }
  };

  const sendQuickReply = async (text: string) => {
    if (!text || !ws || !theirPublicKey) return;
    const mid = cryptoRandomId(9);
    const msg = { text, timestamp: Date.now(), sid: sessionToken, mid };
    const encrypted = encryptMessage(JSON.stringify(msg), theirPublicKey, keyPair.secretKey);
    const ciphertext = formatCiphertextForRelay(encrypted);

    try {
      await postCiphertextToRelay(queueId, ciphertext, mid);
      setMessages((prev: Message[]) => [...prev, {
        id: mid,
        sender: 'me',
        text,
        timestamp: Date.now()
      }]);
    } catch (err) {
      console.error('[QuickReply] Failed to relay message:', err);
      alert('Quick reply could not be delivered.');
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !ws || !theirPublicKey) return;

    const reader = new FileReader();
    reader.onload = async (e2) => {
      const base64 = e2.target?.result as string;
      const mid = cryptoRandomId(9);
      const encrypted = encryptMessage(JSON.stringify({ image: base64, sid: sessionToken, mid }), theirPublicKey, keyPair.secretKey);
      const ciphertext = formatCiphertextForRelay(encrypted);

      try {
        await postCiphertextToRelay(queueId, ciphertext, mid);
        setMessages((prev: Message[]) => [...prev, {
          id: mid,
          sender: 'me',
          image: base64,
          timestamp: Date.now()
        }]);
      } catch (err) {
        console.error('[Image] Failed to relay image:', err);
        alert('Image could not be delivered. Try a smaller image.');
      }
    };
    reader.readAsDataURL(file);
  };

  if (view === 'LANDING') {
    return (
      <div className="relative min-h-screen overflow-hidden">
        <div className="technical-grid absolute inset-0 -z-10" />
        
        <nav className="border-b border-line p-6 flex justify-between items-center bg-paper/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="flex items-center gap-2 font-mono font-bold text-xl tracking-tighter">
            <EyeOff className="text-accent" />
            <span>VELORA</span>
          </div>
          <div className="flex gap-8 items-center text-xs font-mono uppercase tracking-widest font-bold">
            <button onClick={() => setView('DASHBOARD')} className="hover:text-accent transition-colors">Relay Audit</button>
          </div>
        </nav>

        <main className="max-w-7xl mx-auto px-6 py-20 lg:py-10 grid lg:grid-cols-2 gap-20 items-center">
          <motion.div 
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8 }}
          >
            <div className="text-accent font-mono text-sm tracking-[0.2em] uppercase mb-6 flex items-center gap-2">
              <span className="w-8 h-[1px] bg-accent" />
              Secure Metadata-Resistant Protocol
            </div>
            <h1 className="text-xl lg:text-7xl font-bold tracking-tighter leading-[0.85] mb-8 uppercase">
              Unlock <br />
              what was <br />
              <span className="text-accent">never <br /> obvious.</span>
            </h1>
            <p className="text-xl max-w-md opacity-70 mb-12 font-medium leading-relaxed">
              Most secure apps encrypt content but still leak metadata who talks to whom, and when. Velora kills metadata entirely. No accounts. No IDs. Only queues.
            </p>
            <div className="flex flex-wrap gap-4">
              <button 
                onClick={async () => { await createNewQueue(); setView('MESSENGER'); }}
                className="group relative px-8 py-4 bg-ink text-paper font-bold overflow-hidden"
              >
                <div className="absolute inset-0 bg-accent translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
                <span className="relative z-10 flex items-center gap-2">
                  Generate Secure Queue <Send size={18} />
                </span>
              </button>
              <button className="px-8 py-4 border border-line font-bold hover:bg-ink hover:text-paper transition-all">
                Read Whitepaper
              </button>
            </div>

            <div className="mt-12 pt-8 border-t border-line/20">
              <p className="text-xs font-mono uppercase tracking-widest opacity-60 mb-3">OR JOIN EXISTING QUEUE</p>
              <div className="flex gap-2 max-w-sm">
                <input 
                  id="landing-queue-id"
                  placeholder="Paste Queue ID..."
                  autoComplete="off"
                  className="flex-1 border border-line p-3 font-mono text-xs focus:outline-none focus:border-accent transition-colors"
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') {
                      const qid = (e.target as HTMLInputElement).value.trim();
                      if (qid) {
                        setQueueId(qid);
                        setMessages([]);
                        tpkSetter(null);
                        setView('MESSENGER');
                        (e.target as HTMLInputElement).value = '';
                      }
                    }
                  }}
                />
                <button 
                  onClick={() => {
                    const el = document.getElementById('landing-queue-id') as HTMLInputElement;
                    const qid = el.value.trim();
                    if (qid) {
                      setQueueId(qid);
                      setMessages([]);
                      tpkSetter(null);
                      setView('MESSENGER');
                      el.value = '';
                    }
                  }}
                  className="px-6 py-3 bg-accent text-white font-bold text-xs hover:bg-ink transition-colors"
                >
                  JOIN
                </button>
              </div>
            </div>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1, delay: 0.2 }}
            className="relative"
          >
            <div className="aspect-square border border-line p-12 relative flex items-center justify-center">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-accent" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-line" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-line" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-accent" />
              
              <div className="w-full h-full border border-line/20 flex flex-col items-center justify-center gap-8 overflow-hidden">
                <div className="marquee-container w-full border-y border-line/10 py-2">
                  <div className="marquee-content font-mono text-[10px] opacity-30 tracking-widest uppercase">
                    ENCRYPTED_BLOB_0X8273... PACKET_RECEIVED... DECOY_TRAFFIC_ACTIVE... RELAY_BLINDED...&nbsp;
                    ENCRYPTED_BLOB_0X8273... PACKET_RECEIVED... DECOY_TRAFFIC_ACTIVE... RELAY_BLINDED...&nbsp;
                  </div>
                </div>
                <div className="text-center group cursor-pointer" onClick={createNewQueue}>
                  <div className="w-32 h-32 bg-ink/5 border border-line flex items-center justify-center mb-4 group-hover:border-accent group-hover:bg-accent/5 transition-all">
                    <QrCode size={48} className="text-line/40 group-hover:text-accent transition-colors" />
                  </div>
                  <div className="font-mono text-[10px] tracking-widest opacity-50 uppercase">Scan to Connect</div>
                </div>
                <div className="marquee-container w-full border-y border-line/10 py-2">
                  <div className="marquee-content font-mono text-[10px] opacity-30 tracking-widest uppercase" style={{ animationDirection: 'reverse' }}>
                    METADATA_CLEANSED... ANONYMOUS_HANDSHAKE... X25519_KEY_EXCHANGE... NO_LOGS_DETECTED...&nbsp;
                    METADATA_CLEANSED... ANONYMOUS_HANDSHAKE... X25519_KEY_EXCHANGE... NO_LOGS_DETECTED...&nbsp;
                  </div>
                </div>
              </div>
            </div>
            
            <div className="absolute -bottom-10 -right-10 bg-accent text-white p-6 font-mono text-xs max-w-[200px] shadow-2xl">
              <div className="flex items-center gap-2 mb-2">
                <Terminal size={14} />
                <span className="font-bold">TRAFFIC_SHIELD</span>
              </div>
              <div className="opacity-80">Decoy traffic active. Timing analysis defeated. Relay remains blind to interaction events.</div>
            </div>
          </motion.div>
        </main>

        <section className="px-6 py-20 border-t border-line">
          <div className="max-w-7xl mx-auto grid md:grid-cols-3 gap-12">
            {[
              { icon: <Lock />, title: "Full E2EE", desc: "Every message, image, and handshake uses TweetNaCl's battle-tested crypto. Nothing travels in plain." },
              { icon: <Activity />, title: "Decoy Packets", desc: "The relay sends continuous random noise to every queue, making real messaging detectably impossible." },
              { icon: <Shield />, title: "Zero Data", desc: "No usernames. No IPs. No accounts. Queues evaporate after 30 minutes of inactivity. Absolute amnesia." }
            ].map((f, i) => (
              <div key={i} className="p-8 border border-line hover:border-accent transition-colors group">
                <div className="w-12 h-12 bg-ink text-paper flex items-center justify-center mb-6 group-hover:bg-accent transition-colors">{f.icon}</div>
                <h3 className="text-2xl font-bold mb-4 tracking-tight uppercase">{f.title}</h3>
                <p className="opacity-60 text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="border-t border-line p-12 bg-ink text-paper">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-8">
            <div className="flex items-center gap-2 font-mono font-bold tracking-tighter italic">
              <EyeOff size={20} />
              <span>VELORA_RELAY_V2.0</span>
            </div>
            <div className="flex gap-12 font-mono text-[10px] tracking-widest uppercase opacity-50">
              <span className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> Global Relay Online</span>
              <span>Audit Logs Verified</span>
              <span>256bit X25519</span>
            </div>
            <div className="flex gap-6">
              <Github className="opacity-50 hover:opacity-100 cursor-pointer" />
            </div>
          </div>
        </footer>
      </div>
    );
  }

  if (view === 'DASHBOARD') {
    return (
      <div className="min-h-screen p-8 max-w-6xl mx-auto">
        <header className="flex justify-between items-center mb-12 border-b-2 border-line pb-8">
           <div>
             <h1 className="text-5xl font-bold tracking-tighter">RELAY_AUDIT</h1>
             <p className="font-mono text-xs opacity-50 uppercase tracking-widest">Public Anonymized Transparency Log</p>
           </div>
           <button onClick={() => setView('LANDING')} className="flex items-center gap-2 px-6 py-2 border border-line hover:bg-ink hover:text-paper transition-all font-bold">
             <X size={18} /> CLOSE_VIEW
           </button>
        </header>

        <div className="grid md:grid-cols-4 gap-6 mb-12">
          {[
            { label: 'ACTIVE_QUEUES', value: stats?.activeQueues || 0 },
            { label: 'TOTAL_MESSAGES', value: stats?.messageCount || 0 },
            { label: 'REAL_MSG_RATIO', value: stats ? `${Math.round((stats.realMessages / (stats.messageCount || 1)) * 100)}%` : '0%' },
            { label: 'DECOY_MSG_RATIO', value: stats ? `${Math.round((stats.decoyMessages / (stats.messageCount || 1)) * 100)}%` : '0%' }
          ].map((s, i) => (
            <div key={i} className="bg-ink text-paper p-6">
              <div className="text-[10px] font-mono opacity-50 mb-2">{s.label}</div>
              <div className="text-4xl font-mono font-bold">{s.value}</div>
            </div>
          ))}
        </div>

        <div className="grid md:grid-cols-2 gap-12">
          <section>
            <h2 className="text-xl font-bold mb-6 flex items-center gap-2 uppercase tracking-tight">
              <Terminal size={20} className="text-accent" /> Live Audit Log Tail
            </h2>
            <div className="bg-ink text-paper p-4 font-mono text-xs h-[400px] overflow-auto border border-line/20">
              <div className="text-accent mb-4 opacity-70"># HASH(QUEUE_ID) | HASH(BLOB) | TIMESTAMP</div>
              {auditLog.split('\n').filter((l: string) => l.trim()).map((line: string, i: number) => (
                <div key={i} className="mb-1 border-b border-paper/5 pb-1 last:border-0 hover:bg-paper/5 break-all">
                  {line}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-xl font-bold mb-6 flex items-center gap-2 uppercase tracking-tight">
              <Activity size={20} className="text-accent" /> Security Protocol
            </h2>
            <div className="space-y-6">
              <div className="p-6 border border-line">
                 <h3 className="font-bold mb-2 uppercase text-xs text-accent">Proof of Anonymity</h3>
                 <p className="text-sm opacity-70">The relay never sees IP addresses or plaintext. The log above proves that only hashes are persisted. No long-term correlation is possible as IDs vanish every 30m.</p>
              </div>
              <div className="p-6 border border-line bg-paper/50">
                 <h3 className="font-bold mb-2 uppercase text-xs text-accent">Decoy Traffic Integrity</h3>
                 <p className="text-sm opacity-70">Decoys are mathematically indistinguishable from real encrypted blobs to any outside observer. Timing patterns are randomized between 3-8 seconds.</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  // Prevent messenger view without a valid queue ID
  if (view === 'MESSENGER' && !queueId) {
    setView('LANDING');
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-paper">
      <div className="border-b border-line p-4 flex justify-between items-center z-10 bg-white/50 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <button onClick={endCurrentSession} className="p-2 hover:bg-ink hover:text-white transition-colors">
            <X size={20} />
          </button>
          <div>
            {panicMode ? (
              <>
                <div className="font-mono font-bold text-xs tracking-widest text-accent uppercase">CLASSROOM_NOTES</div>
                <div className="font-mono text-[10px] opacity-40 break-all max-w-[250px]">group-planning-thread</div>
                <div className="font-mono text-[10px] text-green-500 mt-1">✓ Shared Study Notes</div>
              </>
            ) : (
              <>
                <div className="font-mono font-bold text-xs tracking-widest text-accent uppercase">VELORA_SESSION</div>
                <div className="font-mono text-[10px] opacity-40 break-all max-w-[250px]">{queueId}</div>
                {hasJoinedPeer && <div className="font-mono text-[10px] text-green-500 mt-1">✓ Joined Peer Queue</div>}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
           {!panicMode && (
             <>
               <div className={`w-2 h-2 rounded-full ${ws ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
               <span className="font-mono text-[10px] uppercase font-bold tracking-widest text-ink/70">
                 {ws ? 'Connected' : 'Offline'}
               </span>
             </>
           )}
           <button
             onClick={activatePanicMode}
             className={`px-3 py-1 border text-[10px] font-mono uppercase tracking-widest font-bold transition-colors ${
               panicMode
                 ? 'border-amber-500 text-amber-600 bg-amber-50'
                 : 'border-red-500 text-red-600 hover:bg-red-600 hover:text-white'
             }`}
           >
             {panicMode ? 'Persona Active' : 'Panic'}
           </button>
           <button
             onClick={() => toggleAgentEnabled()}
             title="Toggle local agent sound (persisted)"
             className={`px-3 py-1 border text-[10px] font-mono uppercase tracking-widest font-bold transition-colors ${
               agentEnabled ? 'border-green-500 text-green-600 hover:bg-green-600 hover:text-white' : 'border-line text-ink/60 hover:bg-ink/5'
             }`}
           >
             {agentEnabled ? 'Agent: Sound ON' : 'Agent: Sound OFF'}
           </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-auto relative">
        <div className="technical-grid absolute inset-0 -z-10" />
        
        {/* Queue Connection Modal - shown only when waiting for peer to join */}
        {!panicMode && !hasJoinedPeer && (
          <div className="absolute inset-0 bg-paper/95 backdrop-blur-md z-20 flex flex-col items-center justify-center p-8 text-center pointer-events-none">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} 
              animate={{ scale: 1, opacity: 1 }}
              className="max-w-md w-full border border-line p-8 bg-paper shadow-2xl pointer-events-auto"
            >
              <QrCode className="mx-auto mb-6 text-accent" size={64} />
              <h2 className="text-3xl font-bold tracking-tighter mb-4 uppercase">
                Waiting for Peer
              </h2>
              <p className="text-sm opacity-60 mb-8">
                Share this unique Queue ID with your partner to establish an end-to-end encrypted connection.
              </p>
              
              <div className="bg-white p-4 inline-block mb-8 border border-line">
                <QRCodeCanvas value={queueId} size={180} />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center space-x-2">
                  <input 
                    readOnly 
                    value={queueId}
                    id="queue-id-display"
                    autoComplete="off"
                    className="flex-1 border border-line p-2 font-mono text-xs bg-ink/5 focus:outline-none"
                    />
                  <button 
                    onClick={() => navigator.clipboard.writeText(queueId)}
                    className="px-4 py-2 bg-ink text-paper font-bold text-xs hover:bg-accent transition-colors"
                  >
                    COPY
                  </button>
                </div>
                <p className="text-[10px] font-mono uppercase opacity-40 mb-3 border-t border-line/10 pt-6">Or paste peer's code to join:</p>
                <div className="flex gap-2 max-w-sm">
                  <input 
                    id="peer-id-input"
                    placeholder="Paste Peer Queue ID..."
                    autoComplete="off"
                    className="flex-1 border border-line p-2 font-mono text-xs focus:outline-none border-accent/20 focus:border-accent"
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === 'Enter') {
                        const val = (e.target as HTMLInputElement).value.trim();
                        console.log('[UI] Enter pressed, input value:', val, 'current queueId:', queueId);
                        if (val && val !== queueId) {
                          console.log('[UI] Joining peer queue:', val);
                          setQueueId(val);
                          setMessages([]);
                          tpkSetter(null);
                          setHasJoinedPeer(true);
                          (e.target as HTMLInputElement).value = '';
                        } else {
                          console.log('[UI] Join blocked - val empty or same as current queueId');
                        }
                      }
                    }}
                  />
                  <button 
                    onClick={() => {
                      const el = document.getElementById('peer-id-input') as HTMLInputElement;
                      const val = el.value.trim();
                      console.log('[UI] JOIN button clicked, input value:', val, 'current queueId:', queueId);
                      if (val && val !== queueId) {
                        console.log('[UI] Joining peer queue:', val);
                        setQueueId(val);
                        setMessages([]);
                        tpkSetter(null);
                        setHasJoinedPeer(true);
                        el.value = '';
                      } else {
                        console.log('[UI] Join blocked - val empty or same as current queueId');
                      }
                    }}
                    className="px-6 py-2 bg-accent text-white font-bold text-xs hover:bg-ink transition-colors pointer-events-auto"
                  >
                    JOIN
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {/* Chat Interface - show once queue is connected */}
        {panicMode ? (
          <div className="flex-1 p-4 md:p-8 overflow-hidden">
            <div className="max-w-4xl mx-auto h-full border border-line bg-white/70 backdrop-blur-sm flex flex-col">
              <div className="border-b border-line px-5 py-4 flex items-center justify-between">
                <div>
                  <div className="font-mono font-bold tracking-wider text-xs uppercase">Study Group Planner</div>
                  <div className="font-mono text-[10px] opacity-50">Project Timeline Discussion</div>
                </div>
                <div className="font-mono text-[10px] opacity-50 uppercase">Persona Mode</div>
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
                {panicMessages.map((m: Message) => (
                  <div key={m.id} className={`flex ${m.sender === 'me' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] p-3 border ${m.sender === 'me' ? 'bg-ink text-paper border-line' : 'bg-white border-line'}`}>
                      <p className="text-sm leading-relaxed">{m.text}</p>
                      <div className={`text-[9px] font-mono mt-2 opacity-50 uppercase ${m.sender === 'me' ? 'text-right' : 'text-left'}`}>
                        {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-line p-4 space-y-3">
                <div className="flex gap-2">
                  <input
                    value={panicDraft}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPanicDraft(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && sendPanicMessage()}
                    placeholder="Add study note..."
                    className="flex-1 border border-line px-3 py-2 bg-white focus:outline-none focus:border-accent"
                  />
                  <button
                    onClick={sendPanicMessage}
                    className="px-5 py-2 bg-ink text-paper font-bold text-xs uppercase tracking-wider hover:bg-accent transition-colors"
                  >
                    Post
                  </button>
                </div>

                <div className="pt-3 border-t border-line/30">
                  <div className="text-[10px] font-mono uppercase tracking-widest opacity-50 mb-2">
                    Secure thread hidden. Enter passphrase to restore.
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={panicUnlockInput}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setPanicUnlockInput(e.target.value);
                        setPanicUnlockError('');
                      }}
                      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && unlockPanicMode()}
                      placeholder="Panic passphrase"
                      className="flex-1 border border-line px-3 py-2 bg-white focus:outline-none focus:border-accent"
                    />
                    <button
                      onClick={unlockPanicMode}
                      className="px-5 py-2 border border-line font-bold text-xs uppercase tracking-wider hover:bg-ink hover:text-paper transition-colors"
                    >
                      Unlock
                    </button>
                  </div>
                  {panicUnlockError && (
                    <div className="mt-2 text-[10px] font-mono uppercase tracking-wider text-red-600">
                      {panicUnlockError}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
        <div className="flex-1 flex flex-col md:flex-row p-4 md:p-8 overflow-hidden">
            <div className="flex-1 flex flex-col overflow-hidden">
                  {chatUrgent && (
                    <div className="w-full bg-red-600 text-white font-mono text-xs uppercase p-2 text-center">
                      URGENT: Possible critical message detected — please review
                    </div>
                  )}
              <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-6 pr-2 scroll-smooth">
                {messages.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center opacity-20 pointer-events-none">
                    <Shield size={64} className="mb-4" />
                    <p className="font-mono text-sm uppercase tracking-[0.3em]">Channel Cleansed</p>
                  </div>
                )}
                <AnimatePresence>
                  {messages.map((m: Message) => (
                    <motion.div 
                      key={m.id}
                      initial={{ opacity: 0, scale: 0.9, y: 10 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      className={`flex ${m.sender === 'me' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div className={`max-w-[80%] p-4 border ${m.sender === 'me' ? 'bg-ink text-paper border-line ml-12' : 'bg-white border-line mr-12'} ${m.urgent ? 'ring-2 ring-red-400/80 bg-red-50' : ''}`}>
                        {m.text && <p className="text-sm leading-relaxed">{m.text}</p>}
                        {/* Quick-reply button for urgent inbound messages */}
                        {m.sender === 'them' && m.urgent && (
                          <div className="mt-2 flex gap-2">
                            <button
                              onClick={() => sendQuickReply(QUICK_REPLY_TEMPLATES[0])}
                              className="px-3 py-1 text-xs font-mono bg-accent text-white rounded"
                            >
                              Reply: "{QUICK_REPLY_TEMPLATES[0]}"
                            </button>
                            <div className="flex gap-1">
                              {QUICK_REPLY_TEMPLATES.slice(1,3).map((t) => (
                                <button key={t} onClick={() => sendQuickReply(t)} className="px-2 py-1 text-[11px] font-mono border border-line rounded bg-white/90">{t}</button>
                              ))}
                            </div>
                          </div>
                        )}
                        {m.image && (
                          <img 
                            src={m.image} 
                            alt="Encrypted Transfer" 
                            className="max-w-full h-auto mt-2 rounded-sm" 
                            referrerPolicy="no-referrer"
                          />
                        )}
                        {m.voice && (
                          <div className="mt-2 w-full">
                            <motion.div
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="flex items-center gap-2 bg-ink/10 p-2 rounded"
                            >
                              <Mic size={14} className="opacity-60" />
                              <audio 
                                controls 
                                className="flex-1" 
                                src={m.voice}
                                style={{ maxHeight: '32px', outline: 'none' }}
                              />
                            </motion.div>
                          </div>
                        )}
                        <div className={`text-[9px] font-mono mt-2 opacity-40 uppercase ${m.sender === 'me' ? 'text-right' : 'text-left'}`}>
                          {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {m.sender === 'me' ? 'SECURE_OUT' : 'SECURE_IN'}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              <div className="mt-6 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-[12px] font-mono">
                    <input
                      type="checkbox"
                      checked={selfDestructEnabled}
                      onChange={(e) => setSelfDestructEnabled(e.target.checked)}
                      disabled={!theirPublicKey || !ws}
                      className="w-4 h-4"
                    />
                    <span className="uppercase opacity-80">Self-destruct</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={selfDestructSeconds}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSelfDestructSeconds(Number(e.target.value) || 1)}
                    disabled={!selfDestructEnabled || !theirPublicKey || !ws}
                    className="w-24 border border-line px-2 py-1 text-sm bg-white"
                    title="Seconds until message is destroyed"
                  />
                  <div className="text-[10px] font-mono opacity-50">seconds</div>
                </div>
                <div className="flex gap-2 h-12">
                  <div className="relative">
                    <input 
                      type="file" 
                      accept="image/*" 
                      className="hidden" 
                      id="img-upload" 
                      name="image-upload"
                      onChange={handleImageUpload}
                    />
                    <label 
                      htmlFor="img-upload" 
                      className={`h-full px-4 border border-line flex items-center justify-center cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                        !theirPublicKey || !ws ? 'opacity-40 cursor-not-allowed' : 'hover:bg-ink hover:text-paper'
                      }`}
                      title={!theirPublicKey || !ws ? 'Peer must be connected' : 'Upload image'}
                    >
                      <ImageIcon size={20} />
                    </label>
                  </div>
                  <div className="relative">
                    <input 
                      type="file" 
                      accept="audio/*" 
                      className="hidden" 
                      id="voice-upload" 
                      name="voice-upload"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const file = e.target.files?.[0];
                        if (file && theirPublicKey && ws) {
                          const reader = new FileReader();
                          reader.onload = async (event) => {
                            const base64 = event.target?.result as string;
                            const mid = cryptoRandomId(9);
                            const encrypted = encryptMessage(JSON.stringify({ voice: base64, sid: sessionToken, mid }), theirPublicKey, keyPair.secretKey);
                            const ciphertext = formatCiphertextForRelay(encrypted);

                            try {
                              await postCiphertextToRelay(queueId, ciphertext);
                              setMessages((prev: Message[]) => [...prev, {
                                id: mid,
                                sender: 'me',
                                voice: base64,
                                timestamp: Date.now()
                              }]);
                            } catch (err) {
                              console.error('[Voice Upload] Failed to relay voice note:', err);
                              alert('Voice note could not be delivered. Try a shorter file.');
                            }
                          };
                          reader.readAsDataURL(file);
                          e.target.value = '';
                        }
                      }}
                    />
                    <label 
                      htmlFor="voice-upload" 
                      className={`h-full px-4 border border-line flex items-center justify-center cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                        !theirPublicKey || !ws ? 'opacity-40 cursor-not-allowed' : 'hover:bg-ink hover:text-paper'
                      }`}
                      title={!theirPublicKey || !ws ? 'Peer must be connected' : 'Upload voice note'}
                    >
                      <Mic size={20} />
                    </label>
                  </div>
                  <button
                    onMouseDown={startVoiceRecording}
                    onMouseUp={stopVoiceRecording}
                    onTouchStart={startVoiceRecording}
                    onTouchEnd={stopVoiceRecording}
                    disabled={!theirPublicKey || !ws}
                    className={`relative h-full px-4 border border-line flex items-center justify-center cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed font-bold text-xs font-mono uppercase tracking-widest ${
                      isRecording 
                        ? 'bg-red-500 text-white border-red-500 shadow-lg shadow-red-500/50 animate-pulse' 
                        : 'hover:bg-ink hover:text-paper'
                    }`}
                    title={isRecording ? 'Recording... Release to stop' : 'Hold to record voice note'}
                  >
                    {isRecording && (
                      <>
                        <motion.div
                          className="absolute inset-0 bg-red-600"
                          animate={{ opacity: [0.3, 0.7, 0.3] }}
                          transition={{ duration: 0.8, repeat: Infinity }}
                        />
                        <motion.div
                          className="absolute inset-1 border border-red-300 rounded"
                          animate={{ scale: [0.95, 1.05, 0.95] }}
                          transition={{ duration: 0.6, repeat: Infinity }}
                        />
                      </>
                    )}
                    <motion.div
                      animate={isRecording ? { scale: [1, 1.3, 1] } : {}}
                      transition={{ duration: 0.5, repeat: isRecording ? Infinity : 0 }}
                      className="relative z-10 flex items-center gap-2"
                    >
                      <span className="hidden md:inline text-xs">{isRecording ? 'REC' : 'HOLD'}</span>
                    </motion.div>
                  </button>
                  <input 
                    id="message-input"
                    value={inputText}
                    autoComplete="off"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInputText(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && sendMessage()}
                    placeholder={!theirPublicKey || !ws ? 'Waiting for peer...' : 'Draft encrypted blob...'}
                    disabled={!theirPublicKey || !ws}
                    className={`flex-1 bg-white border border-line px-4 font-medium focus:outline-none transition-colors ${
                      !theirPublicKey || !ws 
                        ? 'opacity-50 cursor-not-allowed border-line/50' 
                        : 'focus:border-accent'
                    }`}
                  />
                  <button 
                    onClick={sendMessage}
                    disabled={!inputText.trim() || !theirPublicKey || !ws}
                    className="px-8 bg-ink text-paper font-bold hover:bg-accent disabled:opacity-50 disabled:hover:bg-ink transition-all flex items-center gap-2"
                  >
                    <Send size={18} /> <span className="hidden md:inline">SEND</span>
                  </button>
                </div>
                
                <div className="flex justify-between items-center text-[9px] font-mono uppercase tracking-widest opacity-40 px-2">
                  <div className="flex items-center gap-2">
                    <Lock size={10} /> X25519_ACTIVE
                  </div>
                  <div>DECOY_SHIELD: NOMINAL</div>
                  <div>REMAINING_TTL: 29:54</div>
                </div>
              </div>
            </div>

            <div className="hidden lg:flex w-64 border-l border-line p-6 flex-col">
              <div className="flex-1">
                <h3 className="text-xs font-bold uppercase mb-6 tracking-widest text-accent flex items-center gap-2">
                  <Terminal size={14} /> Session Logs
                </h3>
                <div className="space-y-4 font-mono text-[10px] opacity-60">
                   <div className="border-l border-line pl-2">
                     <div className="text-accent underline">HANDSHAKE_INIT</div>
                     <div>Exchange public keys via blinded relay</div>
                   </div>
                   <div className="border-l border-line pl-2">
                     <div className="text-accent underline">CRYPTO_READY</div>
                     <div>XSalsa20-Poly1305 socket established</div>
                   </div>
                   <div className="border-l border-line pl-2">
                     <div className="text-accent underline">TRAFFIC_MIXER</div>
                     <div>Decoy blobs injected every 5s</div>
                   </div>
                </div>
              </div>
              
              <div className="pt-6 border-t border-line">
                 <button 
                   onClick={purgeCurrentSession}
                   className="w-full p-2 border border-red-500/50 text-red-500 hover:bg-red-500 hover:text-white transition-all text-[10px] font-mono uppercase font-bold flex items-center justify-center gap-2"
                 >
                   <Trash2 size={12} /> Purge Session
                 </button>
              </div>
            </div>
          </div>
        )}
        </div>

      {panicSetupOpen && (
        <div className="fixed inset-0 z-[100] bg-ink/55 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-paper border border-line p-6 shadow-2xl">
            <h3 className="font-mono font-bold text-sm uppercase tracking-wider mb-2">Configure Panic Persona</h3>
            <p className="text-xs opacity-70 mb-4">
              Set a secret passphrase. You will need it to return from panic persona to secure chat.
            </p>

            <div className="space-y-3">
              <input
                type="password"
                value={panicSetupValue}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setPanicSetupValue(e.target.value);
                  setPanicSetupError('');
                }}
                placeholder="New passphrase"
                className="w-full border border-line px-3 py-2 bg-white focus:outline-none focus:border-accent"
              />
              <input
                type="password"
                value={panicSetupConfirm}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setPanicSetupConfirm(e.target.value);
                  setPanicSetupError('');
                }}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && savePanicSetup()}
                placeholder="Confirm passphrase"
                className="w-full border border-line px-3 py-2 bg-white focus:outline-none focus:border-accent"
              />

              {panicSetupError && (
                <div className="text-[10px] font-mono uppercase tracking-wider text-red-600">
                  {panicSetupError}
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setPanicSetupOpen(false);
                  setPanicSetupValue('');
                  setPanicSetupConfirm('');
                  setPanicSetupError('');
                }}
                className="px-4 py-2 border border-line text-xs font-bold uppercase tracking-wider hover:bg-ink hover:text-paper transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={savePanicSetup}
                className="px-4 py-2 bg-accent text-white text-xs font-bold uppercase tracking-wider hover:bg-ink transition-colors"
              >
                Save & Activate
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
  );
}
