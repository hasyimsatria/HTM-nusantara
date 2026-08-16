import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // =========================================================
    // 1. SKYWAY TOKEN (FIXED FOR V3 SFU)
    // =========================================================
    if (path === "/skyway/token" || path === "/skyway/token/") {
      try {
        // Gunakan trim() untuk menghindari spasi tak sengaja di environment variables
        const appId = env.SKYWAY_APP_ID?.trim();
        const secretKey = env.SKYWAY_SECRET_KEY?.trim();
        const secretKeyId = env.SKYWAY_SECRET_KEY_ID?.trim();

        if (!appId || !secretKey) {
          return json({ error: "SkyWay Config Missing (APP_ID or SECRET_KEY)" }, 500);
        }

        const token = await signSkyWayToken(appId, secretKey, secretKeyId);

        return json({ token });
      } catch (e) {
        return json({ error: "Token Generation Error", details: e.message }, 500);
      }
    }

    // =========================================================
    // 2. HEALTH CHECK
    // =========================================================
    if (path === "/") {
      return new Response("HTM Worker Online", { status: 200 });
    }

    // =========================================================
    // 3. WEBSOCKET SIGNALING ROOM
    // =========================================================
    const roomMatch = path.match(/^\/room\/([^\/]+)$/);
    if (!roomMatch) return new Response("Not Found", { status: 404 });

    const roomId = roomMatch[1];
    if (!env.VOICE_ENTERPRISE_ROOM) return new Response("Durable Object Binding Missing", { status: 500 });

    const objectId = env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);
    const roomStub = env.VOICE_ENTERPRISE_ROOM.get(objectId);

    return roomStub.fetch(request);
  }
};

// Helper JSON Response
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// =============================================================
// SKYWAY JWT HS256 - PERBAIKAN KRITIS
// =============================================================
async function signSkyWayToken(appId, secretKey, secretKeyId) {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 60; // Buffer 60 detik untuk sinkronisasi jam perangkat
  const exp = now + 3600; // Berlaku 1 jam

  const header = {
    alg: "HS256",
    typ: "JWT",
    kid: secretKeyId || appId // Dashboard SkyWay: Secret Key ID biasanya berbeda dengan App ID
  };

  const payload = {
    iat,
    exp,
    jti: crypto.randomUUID(),
    sub: appId,
    version: 3,
    scope: {
      appId: appId,
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
            forwardings: [
              {
                id: "*",
                actions: ["write"]
              }
            ]
          }
        }
      ]
    }
  };

  const base64UrlEncode = (obj) => {
    const str = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  };

  const tokenData = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

  // --- PERBAIKAN UTAMA: Decode Secret Key dari Base64 ke Raw Bytes ---
  const normalizedSecret = secretKey.replace(/-/g, "+").replace(/_/g, "/");
  const keyBuffer = Uint8Array.from(atob(normalizedSecret), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(tokenData)
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${tokenData}.${encodedSignature}`;
}

// =============================================================
// DURABLE OBJECT (SIGNALING)
// =============================================================
export class VoiceEnterpriseRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const peerId = url.searchParams.get("peer_id") || crypto.randomUUID();
    const name = url.searchParams.get("name") || "USER";
    const loc = url.searchParams.get("loc") || "";

    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({ peerId, name, loc });

    // Broadcast JOIN
    this.broadcast({
      type: "PEER_JOINED",
      peerId,
      name,
      loc
    }, server);

    // Kirim WELCOME ke user baru
    const existingPeers = this.ctx.getWebSockets()
      .filter(s => s !== server)
      .map(s => s.deserializeAttachment()?.peerId)
      .filter(id => id);

    server.send(JSON.stringify({
      type: "WELCOME",
      peerId,
      peers: existingPeers
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const attachment = ws.deserializeAttachment();

      if (data.type === "PING") {
        ws.send(JSON.stringify({ type: "PONG" }));
        return;
      }

      const msg = {
        ...data,
        sender: attachment.peerId,
        name: attachment.name,
        loc: attachment.loc
      };

      if (data.target) {
        this.ctx.getWebSockets().forEach(s => {
          if (s.deserializeAttachment()?.peerId === data.target) {
            s.send(JSON.stringify(msg));
          }
        });
      } else {
        this.broadcast(msg, ws);
      }
    } catch (e) {}
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    if (attachment) {
      this.broadcast({ type: "PEER_LEFT", peerId: attachment.peerId });
    }
  }

  broadcast(msg, exclude) {
    const raw = JSON.stringify(msg);
    this.ctx.getWebSockets().forEach(s => {
      if (s !== exclude) {
        try { s.send(raw); } catch (e) {}
      }
    });
  }
}
