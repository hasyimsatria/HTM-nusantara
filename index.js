import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // =========================================================
    // 1. SKYWAY TOKEN (FIXED FOR V3)
    // =========================================================
    if (path === "/skyway/token" || path === "/skyway/token/") {
      try {
        const appId = env.SKYWAY_APP_ID || "b46c7eb1-d845-4d63-98bc-6802f04d09bd";
        const secretKey = env.SKYWAY_SECRET_KEY || "1GgKiqvIVU0YYQl7xsoTI2vgQPTBDoyI3IkptLTKGpc=";

        if (!appId || !secretKey) {
          return new Response(JSON.stringify({ error: "Config Missing" }), { status: 500 });
        }

        const token = await signSkyWayToken(appId.trim(), secretKey.trim());

        return new Response(JSON.stringify({ token }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "JWT Error", details: e.message }), { status: 500 });
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

// =============================================================
// SKYWAY JWT HS256 SIGNER
// =============================================================
async function signSkyWayToken(appId, secretKey) {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 120; // Buffer 2 menit untuk sinkronisasi waktu
  const exp = now + 3600; // Berlaku 1 jam

  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  const payload = {
    iat,
    exp,
    jti: crypto.randomUUID(),
    version: 3, // Wajib untuk SkyWay v3
    scope: {
      appId: appId, // Wajib di root scope
      app: {
        id: appId,
        actions: ["read"]
      },
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
    const bin = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };

  const tokenData = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

  // --- PERBAIKAN KRITIS: Decode Secret Key dari Base64 ke Raw Bytes ---
  const normalizedSecret = secretKey.replace(/-/g, "+").replace(/_/g, "/");
  const keyBytes = Uint8Array.from(atob(normalizedSecret), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(tokenData));

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
