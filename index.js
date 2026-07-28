import { DurableObject } from "cloudflare:workers";

/**
 * =====================================================================
 * ENTERPRISE HTTP ROUTER & SECURITY GATEWAY
 * =====================================================================
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Halaman Antarmuka Web Klien Bawaan Server
    if (path === '/' || path === '/index.html') {
      return new Response(getEnterpriseClientHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // Endpoint API untuk Mengambil Riwayat Obrolan/Log dari SQLite Durable Object
    const historyMatch = path.match(/^\/api\/room\/([^\/]+)\/history$/);
    if (historyMatch && request.method === "GET") {
      const roomId = historyMatch[1];
      const stub = env.VOICE_ENTERPRISE_ROOM.get(env.VOICE_ENTERPRISE_ROOM.idFromName(roomId));
      return stub.fetch(new Request(url.origin + "/internal-fetch-history", request));
    }

    // Endpoint WebSocket Signaling Room
    const roomMatch = path.match(/^\/room\/([^\/]+)$/);
    if (!roomMatch) {
      return new Response(JSON.stringify({ error: "Endpoint tidak ditemukan. Gunakan /room/{room_id}" }), { 
        status: 404, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    const roomId = roomMatch[1];
    const objectId = env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);
    const roomStub = env.VOICE_ENTERPRISE_ROOM.get(objectId);

    return roomStub.fetch(request);
  }
};

/**
 * =====================================================================
 * STATEFUL ROOM MANAGER (DURABLE OBJECT + SQLITE + HIBERNATION)
 * =====================================================================
 */
export class VoiceEnterpriseRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.initDatabase();
  }

  initDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_members (
        peer_id TEXT PRIMARY KEY,
        joined_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS room_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        type TEXT,
        payload TEXT,
        timestamp INTEGER
      );
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Handler internal untuk mengambil data riwayat dari SQLite
    if (url.pathname === "/internal-fetch-history") {
      const history = this.sql.exec("SELECT * FROM room_messages ORDER BY timestamp DESC LIMIT 50").toArray();
      return new Response(JSON.stringify({ status: "success", history }, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Dibutuhkan koneksi WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const peerId = url.searchParams.get("peer_id") || `user_${Math.random().toString(36).substring(2, 8)}`;

    // Daftarkan koneksi ke API Hibernation Cloudflare
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peerId, connectedAt: Date.now() });

    // Simpan ke database SQLite
    this.sql.exec("INSERT OR REPLACE INTO room_members (peer_id, joined_at) VALUES (?, ?)", peerId, Date.now());

    // Broadcast ke peserta lain
    this.broadcastToOthers(server, {
      type: "PEER_JOINED",
      peerId: peerId,
      active_count: this.ctx.getWebSockets().length
    });

    // Kirim data selamat datang ke user baru
    const existingPeers = this.ctx.getWebSockets()
      .filter(s => s !== server)
      .map(s => s.deserializeAttachment().peerId);

    server.send(JSON.stringify({
      type: "WELCOME",
      peerId: peerId,
      peers: existingPeers,
      active_count: this.ctx.getWebSockets().length,
      server_time: Date.now()
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const { peerId } = ws.deserializeAttachment();

      // Tangani Keep-Alive PING dari klien
      if (data.type === "PING") {
        ws.send(JSON.stringify({ type: "PONG", timestamp: Date.now() }));
        return;
      }

      // Simpan log pesan penting ke SQLite jika diperlukan
      if (data.save_log) {
        this.sql.exec(
          "INSERT INTO room_messages (sender, type, payload, timestamp) VALUES (?, ?, ?, ?)",
          peerId, data.type, JSON.stringify(data.payload), Date.now()
        );
      }

      // Routing signaling WebRTC (Offer, Answer, ICE Candidate) secara presisi ke target
      if (data.target) {
        const sockets = this.ctx.getWebSockets();
        for (const socket of sockets) {
          const targetAttachment = socket.deserializeAttachment();
          if (targetAttachment && targetAttachment.peerId === data.target) {
            socket.send(JSON.stringify({
              type: data.type,
              sender: peerId,
              payload: data.payload
            }));
            break;
          }
        }
      } else {
        this.broadcastToOthers(ws, {
          type: data.type,
          sender: peerId,
          payload: data.payload
        });
      }
    } catch (e) {
      ws.send(JSON.stringify({ error: "Format payload pesan tidak valid" }));
    }
  }

  async webSocketClose(ws, code, reason) {
    this.cleanup(ws);
  }

  async webSocketError(ws, error) {
    this.cleanup(ws);
  }

  cleanup(ws) {
    try {
      const { peerId } = ws.deserializeAttachment();
      this.sql.exec("DELETE FROM room_members WHERE peer_id = ?", peerId);
      ws.close();
      this.broadcastToAll({
        type: "PEER_LEFT",
        peerId: peerId,
        active_count: this.ctx.getWebSockets().length
      });
    } catch (e) {}
  }

  broadcastToAll(msg) {
    const raw = JSON.stringify(msg);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(raw); } catch (e) {}
    }
  }

  broadcastToOthers(senderWs, msg) {
    const raw = JSON.stringify(msg);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== senderWs) {
        try { socket.send(raw); } catch (e) {}
      }
    }
  }
}

/**
 * =====================================================================
 * ENTERPRISE CLIENT FRONTEND (UI + WEB-RTC CORE + KEEPALIVE)
 * =====================================================================
 */
function getEnterpriseClientHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enterprise Voice Server</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f8fafc; text-align: center; padding: 40px; }
        .card { background: #1e293b; max-width: 440px; margin: auto; padding: 30px; border-radius: 14px; box-shadow: 0 10px 25px rgba(0,0,0,0.6); }
        input, button { padding: 12px; margin: 10px 0; width: 100%; border-radius: 8px; border: none; font-size: 14px; box-sizing: border-box; }
        input { background: #334155; color: white; }
        button { background: #38bdf8; color: #0f172a; font-weight: bold; cursor: pointer; transition: 0.2s; }
        button:hover { background: #0ea5e9; }
        .status { margin-top: 15px; font-size: 13px; color: #94a3b8; }
        .audio-grid { margin-top: 20px; display: flex; flex-direction: column; gap: 8px; }
        .peer-box { background: #0f172a; padding: 10px; border-radius: 6px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; }
    </style>
</head>
<body>
    <div class="card">
        <h2>Enterprise Voice Node</h2>
        <p>Cloudflare Edge + SQLite + WebRTC</p>
        <input type="text" id="roomInput" placeholder="Nama Ruangan" value="ruang-utama">
        <input type="text" id="nameInput" placeholder="Nama Panggilan Kamu">
        <button id="joinBtn" onclick="joinRoom()">Gabung Ruangan</button>
        <button id="leaveBtn" onclick="leaveRoom()" style="background:#ef4444; color:white; display:none;">Keluar Ruangan</button>
        <div class="status" id="statusText">Status: Terputus</div>
        <div class="audio-grid" id="audioContainer"></div>
    </div>

    <script>
        let ws, localStream;
        let peers = {};
        let pingInterval;
        const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

        async function joinRoom() {
            const room = document.getElementById('roomInput').value.trim();
            const name = document.getElementById('nameInput').value.trim() || 'user_' + Math.floor(Math.random()*1000);
            if(!room) return alert('Masukkan nama ruangan terlebih dahulu!');

            try {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            } catch(e) {
                return alert('Akses mikrofon ditolak atau tidak didukung!');
            }

            document.getElementById('statusText').innerText = 'Menghubungkan ke server...';
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${proto}//\${window.location.host}/room/\${room}?peer_id=\${name}\`);

            ws.onopen = () => {
                document.getElementById('statusText').innerText = 'Terhubung ke Ruangan: ' + room;
                document.getElementById('joinBtn').style.display = 'none';
                document.getElementById('leaveBtn').style.display = 'block';

                // Jalankan Keep-Alive Ping setiap 30 detik untuk mencegah koneksi terputus timeout
                pingInterval = setInterval(() => {
                    if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PING' }));
                }, 30000);
            };

            ws.onmessage = async (e) => {
                const data = JSON.parse(e.data);
                if(data.type === 'WELCOME') {
                    for(let remotePeer of data.peers) {
                        await createConnection(remotePeer, true);
                    }
                } else if(data.type === 'PEER_JOINED') {
                    // Peserta baru masuk, siap menerima koneksi
                } else if(data.type === 'OFFER') {
                    await handleOffer(data.sender, data.payload);
                } else if(data.type === 'ANSWER') {
                    await handleAnswer(data.sender, data.payload);
                } else if(data.type === 'ICE') {
                    await handleIce(data.sender, data.payload);
                } else if(data.type === 'PEER_LEFT') {
                    removePeerAudio(data.peerId);
                }
            };
        }

        function createPC(remotePeerId) {
            const pc = new RTCPeerConnection(rtcConfig);
            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

            pc.ontrack = (e) => {
                appendPeerAudio(remotePeerId, e.streams[0]);
            };

            pc.onicecandidate = (e) => {
                if(e.candidate) {
                    ws.send(JSON.stringify({ type: 'ICE', target: remotePeerId, payload: e.candidate }));
                }
            };
            peers[remotePeerId] = pc;
            return pc;
        }

        async function createConnection(remotePeerId, isInitiator) {
            const pc = createPC(remotePeerId);
            if(isInitiator) {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: 'OFFER', target: remotePeerId, payload: offer }));
            }
        }

        async function handleOffer(sender, offer) {
            const pc = createPC(sender);
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'ANSWER', target: sender, payload: answer }));
        }

        async function handleAnswer(sender, answer) {
            if(peers[sender]) {
                await peers[sender].setRemoteDescription(new RTCSessionDescription(answer));
            }
        }

        async function handleIce(sender, candidate) {
            if(peers[sender]) {
                await peers[sender].addIceCandidate(new RTCIceCandidate(candidate));
            }
        }

        function appendPeerAudio(peerId, stream) {
            let container = document.getElementById('audioContainer');
            if(document.getElementById('audio_' + peerId)) return;

            let box = document.createElement('div');
            box.className = 'peer-box';
            box.id = 'box_' + peerId;
            box.innerHTML = \`<span>Speaker: \${peerId}</span>\`;

            let audio = document.createElement('audio');
            audio.id = 'audio_' + peerId;
            audio.srcObject = stream;
            audio.autoplay = true;
            box.appendChild(audio);
            container.appendChild(box);
        }

        function removePeerAudio(peerId) {
            if(peers[peerId]) {
                peers[peerId].close();
                delete peers[peerId];
            }
            let box = document.getElementById('box_' + peerId);
            if(box) box.remove();
        }

        function leaveRoom() {
            clearInterval(pingInterval);
            if(localStream) localStream.getTracks().forEach(t => t.stop());
            Object.values(peers).forEach(pc => pc.close());
            if(ws) ws.close();
            peers = {};
            document.getElementById('audioContainer').innerHTML = '';
            document.getElementById('statusText').innerText = 'Status: Terputus';
            document.getElementById('joinBtn').style.display = 'block';
            document.getElementById('leaveBtn').style.display = 'none';
        }
    </script>
</body>
</html>`;
}
