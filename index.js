import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/skyway/token" || path === "/skyway/token/") {
      try {
        // Ambil dari Environment Variable atau gunakan langsung yang Anda berikan
        const appId = (env.SKYWAY_APP_ID || "b46c7eb1-d845-4d63-98bc-6802f04d09bd").trim();
        const secretKey = (env.SKYWAY_SECRET_KEY || "1GgKiqvIVU0YYQl7xsoTI2vgQPTBDoyI3IkptLTKGpc=").trim();
        
        // Gunakan Application ID sebagai 'kid' jika variabel ID khusus tidak ada
        const kid = (env.SKYWAY_SECRET_KEY_ID || appId).trim();

        const token = await signSkyWayToken(appId, secretKey, kid);

        return new Response(JSON.stringify({ token }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Token Error", details: e.message }), { status: 500 });
      }
    }

    if (path === "/") return new Response("HTM Worker Online", { status: 200 });

    const roomMatch = path.match(/^\/room\/([^\/]+)$/);
    if (!roomMatch) return new Response("Not Found", { status: 404 });

    const roomId = roomMatch[1];
    if (!env.VOICE_ENTERPRISE_ROOM) return new Response("Durable Object Missing", { status: 500 });

    const objectId = env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);
    const roomStub = env.VOICE_ENTERPRISE_ROOM.get(objectId);
    return roomStub.fetch(request);
  }
};

async function signSkyWayToken(appId, secretKey, kid) {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 60; // 60 detik buffer
  const exp = now + 3600; // 1 jam durasi

  const header = {
    alg: "HS256",
    typ: "JWT",
    kid: kid // Key ID untuk identifikasi kunci
  };

  const payload = {
    jti: crypto.randomUUID(),
    iat: iat,
    exp: exp,
    scope: {
      appId: appId,
      app: { id: appId, turn: true, actions: ["read"] },
      rooms: [
        {
          id: "*",
          methods: ["create", "query", "read", "updateMetadata", "close"],
          member: {
            id: "*",
            methods: ["create", "publish", "subscribe", "read", "updateMetadata", "leave"]
          },
          sfuBot: {
            id: "*",
            actions: ["write"],
            forwardings: [{ id: "*", actions: ["write"] }]
          }
        }
      ]
    }
  };

  const base64UrlEncode = (obj) => {
    const str = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(str);
    const bin = String.fromCharCode(...bytes);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };

  const tokenData = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

  // DECODE SECRET KEY DARI BASE64 (Sangat Penting)
  const normalizedSecret = secretKey.replace(/-/g, "+").replace(/_/g, "/");
  const keyBuffer = Uint8Array.from(atob(normalizedSecret), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(tokenData));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${tokenData}.${encodedSignature}`;
}

export class VoiceEnterpriseRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peerId = url.searchParams.get("peer_id") || crypto.randomUUID();
    const name = url.searchParams.get("name") || "USER";
    const loc = url.searchParams.get("loc") || "";
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peerId, name, loc });
    this.broadcast({ type: "PEER_JOINED", peerId, name, loc }, server);
    const existing = this.ctx.getWebSockets().filter(s => s !== server).map(s => s.deserializeAttachment()?.peerId).filter(id => id);
    server.send(JSON.stringify({ type: "WELCOME", peerId, peers: existing }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const att = ws.deserializeAttachment();
      if (data.type === "PING") { ws.send(JSON.stringify({ type: "PONG" })); return; }
      const msg = { ...data, sender: att.peerId, name: att.name, loc: att.loc };
      if (data.target) {
        this.ctx.getWebSockets().forEach(s => { if (s.deserializeAttachment()?.peerId === data.target) s.send(JSON.stringify(msg)); });
      } else { this.broadcast(msg, ws); }
    } catch (e) {}
  }
  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (att) this.broadcast({ type: "PEER_LEFT", peerId: att.peerId });
  }
  broadcast(msg, exclude) {
    const raw = JSON.stringify(msg);
    this.ctx.getWebSockets().forEach(s => { if (s !== exclude) { try { s.send(raw); } catch (e) {} } });
  }
}
