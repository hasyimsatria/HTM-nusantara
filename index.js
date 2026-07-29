import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Endpoint WebSocket Signaling Room
    const roomMatch = path.match(/^\/room\/([^\/]+)$/);
    if (!roomMatch) return new Response("Not Found", { status: 404 });

    const roomId = roomMatch[1];
    const objectId = env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);
    const roomStub = env.VOICE_ENTERPRISE_ROOM.get(objectId);

    return roomStub.fetch(request);
  }
};

export class VoiceEnterpriseRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });

    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Ambil metadata dari URL (dikirim oleh Flutter)
    const peerId = url.searchParams.get("peer_id");
    const name = url.searchParams.get("name") || "USER";
    const loc = url.searchParams.get("loc") || "";

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peerId, name, loc, connectedAt: Date.now() });

    // Beritahu yang lain ada user baru
    this.broadcastToOthers(server, {
      type: "PEER_JOINED",
      peerId: peerId,
      active_count: this.ctx.getWebSockets().length
    });

    // Kirim data selamat datang ke user ini
    const existingPeers = this.ctx.getWebSockets()
      .filter(s => s !== server)
      .map(s => s.deserializeAttachment().peerId);

    server.send(JSON.stringify({
      type: "WELCOME",
      peerId: peerId,
      peers: existingPeers,
      active_count: this.ctx.getWebSockets().length
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const { peerId, name, loc } = ws.deserializeAttachment();

      if (data.type === "PING") {
        ws.send(JSON.stringify({ type: "PONG" }));
        return;
      }

      // Payload yang akan dikirim (ditambah metadata pengirim)
      const broadcastData = {
        type: data.type,
        sender: peerId,
        name: name,
        loc: loc,
        payload: data.payload
      };

      if (data.target) {
        // Kirim ke target spesifik (Signaling WebRTC)
        for (const socket of this.ctx.getWebSockets()) {
          if (socket.deserializeAttachment().peerId === data.target) {
            socket.send(JSON.stringify(broadcastData));
            break;
          }
        }
      } else {
        // Broadcast ke semua (PTT Status, dll)
        this.broadcastToOthers(ws, broadcastData);
      }
    } catch (e) {}
  }

  async webSocketClose(ws) {
    const { peerId } = ws.deserializeAttachment();
    this.broadcastToAll({
      type: "PEER_LEFT",
      peerId: peerId,
      active_count: this.ctx.getWebSockets().length
    });
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
