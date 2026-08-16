import { DurableObject } from "cloudflare:workers";


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;


    // Health Check
    if (path === "/") {
      return new Response("HTM Worker Online", {
        status: 200
      });
    }


    // =========================
    // WEBSOCKET ROOM ROUTING
    // =========================

    const roomMatch = path.match(/^\/room\/([^\/]+)$/);

    if (!roomMatch) {
      return new Response("Not Found", {
        status: 404
      });
    }


    // Pastikan WebSocket
    const upgrade = request.headers.get("Upgrade");

    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", {
        status: 426
      });
    }


    const roomId = roomMatch[1];


    if (!env.VOICE_ENTERPRISE_ROOM) {
      return new Response("Durable Object Missing", {
        status: 500
      });
    }


    const id = env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);

    const room = env.VOICE_ENTERPRISE_ROOM.get(id);


    return room.fetch(request);
  }
};



export class VoiceEnterpriseRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
  }


  async fetch(request) {

    const url = new URL(request.url);


    const upgrade = request.headers.get("Upgrade");

    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", {
        status: 426
      });
    }


    const pair = new WebSocketPair();

    const [client, server] = Object.values(pair);


    const peerId =
      url.searchParams.get("peer_id") ||
      crypto.randomUUID();


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
      loc
    });


    // Broadcast user masuk
    this.broadcast(
      {
        type: "PEER_JOINED",
        peerId,
        name,
        loc
      },
      server
    );


    const existing =
      this.ctx
        .getWebSockets()
        .filter(ws => ws !== server)
        .map(ws => ws.deserializeAttachment()?.peerId)
        .filter(Boolean);



    server.send(JSON.stringify({
      type: "WELCOME",
      peerId,
      peers: existing
    }));


    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }



  async webSocketMessage(ws, message) {

    try {

      const data = JSON.parse(message);

      const att = ws.deserializeAttachment();


      // heartbeat
      if (data.type === "PING") {

        ws.send(JSON.stringify({
          type: "PONG"
        }));

        return;
      }



      const payload = {
        ...data,
        sender: att.peerId,
        name: att.name,
        loc: att.loc
      };



      // private message
      if (data.target) {

        this.ctx
          .getWebSockets()
          .forEach(socket => {

            const target =
              socket.deserializeAttachment()?.peerId;


            if (target === data.target) {
              socket.send(JSON.stringify(payload));
            }

          });


      } else {

        this.broadcast(payload, ws);

      }


    } catch (e) {

    }

  }




  async webSocketClose(ws) {

    const att = ws.deserializeAttachment();


    if (att) {

      this.broadcast({
        type: "PEER_LEFT",
        peerId: att.peerId
      });

    }

  }




  broadcast(message, exclude) {

    const data = JSON.stringify(message);


    this.ctx
      .getWebSockets()
      .forEach(ws => {

        if (ws !== exclude) {

          try {
            ws.send(data);
          } catch(e) {}

        }

      });

  }

}
