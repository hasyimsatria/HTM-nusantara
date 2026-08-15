import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/skyway/token" || path === "/skyway/token/") {
      try {
        const appId = env.SKYWAY_APP_ID;
        const secretKey = env.SKYWAY_SECRET_KEY;

        if (!appId || !secretKey) {
          return new Response(JSON.stringify({ error: "SkyWay Config Missing" }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        const token = await signSkyWayToken(appId, secretKey);
        return new Response(JSON.stringify({ token }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Token Error", details: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    if (path === "/") return new Response("HTM Worker Online", { status: 200 });

    const roomMatch = path.match(/^\/room\/([^\/]+)$/);
    if (!roomMatch) return new Response("Not Found", { status: 404 });

    const roomId = roomMatch[1];
    const objectId = env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);
    const roomStub = env.VOICE_ENTERPRISE_ROOM.get(objectId);
    return roomStub.fetch(request);
  }
};

async function signSkyWayToken(appId, secretKey) {
  const header = { alg: "HS256", typ: "JWT" };

  // FIX: Kurangi 300 detik (5 menit) untuk menghindari error "invalid/expired" akibat perbedaan waktu
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 300;
  const exp = now + 3600;
  const jti = crypto.randomUUID();

  const payload = {
    jti,
    iat,
    exp,
    version: 3,
    scope: {
      appId: appId,
      app: {
        id: appId,
        turn: true,
        actions: ["read"]
      },
      rooms: [
        {
          name: "*",
          methods: ["create", "query", "read", "updateMetadata", "close"],
          member: {
            name: "*",
            methods: ["create", "publish", "subscribe", "read", "updateMetadata", "leave"]
          }
        }
      ]
    }
  };

  const base64UrlEncode = (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };

  const tokenData = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(tokenData));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${tokenData}.${encodedSignature}`;
}

export class VoiceEnterpriseRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WS Expected", { status: 426 });
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const peerId = url.searchParams.get("peer_id");
    const name = url.searchParams.get("name") || "USER";
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peerId, name, connectedAt: Date.now() });
    this.broadcastToOthers(server, { type: "PEER_JOINED", peerId });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    const data = JSON.parse(message);
    const { peerId } = ws.deserializeAttachment();
    if (data.type === "PING") { ws.send(JSON.stringify({ type: "PONG" })); return; }
    this.broadcastToOthers(ws, { ...data, sender: peerId });
  }
  async webSocketClose(ws) {
    const { peerId } = ws.deserializeAttachment();
    this.broadcastToAll({ type: "PEER_LEFT", peerId });
  }
  broadcastToAll(msg) {
    const raw = JSON.stringify(msg);
    for (const s of this.ctx.getWebSockets()) { try { s.send(raw); } catch (e) {} }
  }
  broadcastToOthers(sender, msg) {
    const raw = JSON.stringify(msg);
    for (const s of this.ctx.getWebSockets()) {
      if (s !== sender) { try { s.send(raw); } catch (e) {} }
    }
  }
}
