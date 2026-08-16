import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // =========================================================
    // 1. SKYWAY TOKEN (FIXED SIGNATURE & SCOPE)
    // =========================================================
    if (path === "/skyway/token" || path === "/skyway/token/") {
      try {
        const appId = env.SKYWAY_APP_ID?.trim();
        const secretKey = env.SKYWAY_SECRET_KEY?.trim();
        // SANGAT PENTING: Ambil Secret Key ID dari dashboard SkyWay
        const secretKeyId = env.SKYWAY_SECRET_KEY_ID?.trim();

        if (!appId || !secretKey) {
          return json({ error: "Environment variables SKYWAY_APP_ID or SKYWAY_SECRET_KEY are missing" }, 500);
        }

        const token = await signSkyWayToken(appId, secretKey, secretKeyId);
        return json({ token });
      } catch (e) {
        return json({ error: "JWT Generation Failed", details: e.message }, 500);
      }
    }

    if (path === "/") return new Response("HTM Worker Online", { status: 200 });

    const roomMatch = path.match(/^\/room\/([^\/]+)$/);
    if (!roomMatch) return new Response("Not Found", { status: 404 });

    const roomId = roomMatch[1];
    if (!env.VOICE_ENTERPRISE_ROOM) return new Response("Durable Object Binding Missing", { status: 500 });

    const objectId = env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);
    const roomStub = env.VOICE_ENTERPRISE_ROOM.get(objectId);
    return roomStub.fetch(request);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// =============================================================
// SKYWAY JWT SIGNER (PROPER BASE64 DECODING)
// =============================================================
async function signSkyWayToken(appId, secretKey, secretKeyId) {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 120; // Gunakan buffer 2 menit untuk toleransi jam HP yang tidak akurat
  const exp = now + 3600; // Berlaku 1 jam

  const header = {
    alg: "HS256",
    typ: "JWT",
    kid: secretKeyId || appId // Jika Secret Key ID tidak ada, gunakan App ID (Meski disarankan sk-...)
  };

  const payload = {
    iat,
    exp,
    jti: crypto.randomUUID(),
    sub: appId,
    version: 3,
    scope: {
      appId: appId,
      app: { id: appId, actions: ["read"] },
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

  const base64UrlEncode = (v) => {
    const bin = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };

  const tokenData = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

  // --- PERBAIKAN KRITIS: Decode Secret Key dari Base64 ke Raw Bytes ---
  // Jangan gunakan TextEncoder().encode(secretKey)
  const normalizedSecret = secretKey.replace(/-/g, "+").replace(/_/g, "/");
  const keyBytes = Uint8Array.from(atob(normalizedSecret), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(tokenData)
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${tokenData}.${encodedSignature}`;
}

// =============================================================
// DURABLE OBJECT (TETAP SAMA)
// =============================================================
export class VoiceEnterpriseRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Upgrade Required", { status: 426 });
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
