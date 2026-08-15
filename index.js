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
          return json({ error: "Config Missing" }, 500);
        }

        const token = await signSkyWayToken(appId, secretKey);
        return json({ token });
      } catch (e) {
        return json({ error: "Token Error", details: e.message }, 500);
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

async function signSkyWayToken(appId, secretKey) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    jti: crypto.randomUUID(),
    iat: now - 60, // Buffer 1 menit
    exp: now + 3600,
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

  const base64UrlEncode = (str) => {
    const bytes = new TextEncoder().encode(JSON.stringify(str));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
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
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
}
