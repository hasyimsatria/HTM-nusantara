import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // =========================================================
    // 1. SKYWAY TOKEN
    // =========================================================
    if (path === "/skyway/token" || path === "/skyway/token/") {
      try {
        const appId = env.SKYWAY_APP_ID;
        const secretKey = env.SKYWAY_SECRET_KEY;

        if (!appId || !secretKey) {
          return new Response(
            JSON.stringify({
              error: "SkyWay Config Missing"
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              }
            }
          );
        }

        const token = await signSkyWayToken(appId, secretKey);

        return new Response(
          JSON.stringify({ token }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({
            error: "Token Generation Error",
            details: e?.message || "Unknown error"
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      }
    }

    // =========================================================
    // 2. HEALTH CHECK
    // =========================================================
    if (path === "/") {
      return new Response("HTM Worker Online", {
        status: 200
      });
    }

    // =========================================================
    // 3. WEBSOCKET SIGNALING ROOM
    // =========================================================
    const roomMatch = path.match(/^\/room\/([^\/]+)$/);

    if (!roomMatch) {
      return new Response("Not Found", {
        status: 404
      });
    }

    const roomId = roomMatch[1];

    if (!env.VOICE_ENTERPRISE_ROOM) {
      return new Response(
        "Durable Object VOICE_ENTERPRISE_ROOM not bound",
        {
          status: 500
        }
      );
    }

    const objectId =
      env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);

    const roomStub =
      env.VOICE_ENTERPRISE_ROOM.get(objectId);

    return roomStub.fetch(request);
  }
};


// =============================================================
// SKYWAY JWT HS256 (Updated Payload Structure)
// =============================================================
async function signSkyWayToken(appId, secretKey) {
  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 86400; // Diberikan waktu 24 jam agar tidak cepat expired
  const jti = crypto.randomUUID();

  const payload = {
    jti: jti,
    iat: iat,
    exp: exp,
    version: 3,
    scope: {
      app: {
        id: appId,
        turn: true,
        actions: ["read"]
      },
      rooms: [
        {
          name: "*",
          methods: ["create", "read", "write", "delete", "close", "updateMetadata"],
          member: {
            name: "*",
            methods: ["create", "read", "write", "delete", "leave", "updateMetadata"],
            publication: {
              actions: ["create", "read", "write", "delete", "updateMetadata"]
            },
            subscription: {
              actions: ["create", "read", "write", "delete", "updateMetadata"]
            }
          }
        }
      ]
    }
  };

  const base64UrlEncode = (value) => {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  };

  const encodedHeader = base64UrlEncode(header);
  const encodedPayload = base64UrlEncode(payload);
  const tokenData = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(tokenData)
  );

  const encodedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signature))
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${tokenData}.${encodedSignature}`;
}


// =============================================================
// DURABLE OBJECT
// =============================================================
export class VoiceEnterpriseRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.env = env;
  }

  async fetch(request) {

    if (
      request.headers.get("Upgrade") !==
      "websocket"
    ) {
      return new Response(
        "Expected Upgrade: websocket",
        {
          status: 426
        }
      );
    }

    const url = new URL(request.url);

    const pair =
      new WebSocketPair();

    const [client, server] =
      Object.values(pair);

    // Metadata dari Flutter
    const peerId =
      url.searchParams.get("peer_id");

    const name =
      url.searchParams.get("name") ||
      "USER";

    const loc =
      url.searchParams.get("loc") ||
      "";

    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({
      peerId,
      name,
      loc,
      connectedAt: Date.now()
    });

    // Beritahu user lain
    this.broadcastToOthers(server, {
      type: "PEER_JOINED",
      peerId,
      active_count:
        this.ctx.getWebSockets().length
    });

    // User yang baru masuk
    const existingPeers =
      this.ctx
        .getWebSockets()
        .filter(
          (s) => s !== server
        )
        .map(
          (s) =>
            s.deserializeAttachment()
              .peerId
        );

    server.send(
      JSON.stringify({
        type: "WELCOME",
        peerId,
        peers: existingPeers,
        active_count:
          this.ctx.getWebSockets().length
      })
    );

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }


  async webSocketMessage(ws, message) {

    try {

      const data =
        JSON.parse(message);

      const {
        peerId,
        name,
        loc
      } =
        ws.deserializeAttachment();


      // PING
      if (data.type === "PING") {

        ws.send(
          JSON.stringify({
            type: "PONG"
          })
        );

        return;
      }


      const broadcastData = {

        type: data.type,

        sender: peerId,

        name,

        loc,

        payload: data.payload
      };


      // Target tertentu
      if (data.target) {

        for (
          const socket
          of this.ctx.getWebSockets()
        ) {

          const attachment =
            socket.deserializeAttachment();

          if (
            attachment.peerId ===
            data.target
          ) {

            socket.send(
              JSON.stringify(
                broadcastData
              )
            );

            break;
          }
        }

      } else {

        // Broadcast
        this.broadcastToOthers(
          ws,
          broadcastData
        );
      }

    } catch (e) {
      // Ignore malformed messages
    }
  }


  async webSocketClose(ws) {

    const {
      peerId
    } =
      ws.deserializeAttachment();

    this.broadcastToAll({

      type: "PEER_LEFT",

      peerId,

      active_count:
        this.ctx.getWebSockets()
          .length
    });
  }


  broadcastToAll(msg) {

    const raw =
      JSON.stringify(msg);

    for (
      const socket
      of this.ctx.getWebSockets()
    ) {

      try {
        socket.send(raw);
      } catch (e) {
        // Ignore closed socket
      }
    }
  }


  broadcastToOthers(
    senderWs,
    msg
  ) {

    const raw =
      JSON.stringify(msg);

    for (
      const socket
      of this.ctx.getWebSockets()
    ) {

      if (
        socket !== senderWs
      ) {

        try {
          socket.send(raw);
        } catch (e) {
          // Ignore closed socket
        }
      }
    }
  }
}
