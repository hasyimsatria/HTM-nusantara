import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health
    if (path === "/") {
      return new Response("HTM Worker Online");
    }

    // Room WebSocket
    const roomMatch = path.match(/^\/room\/([^\/]+)$/);

    if (!roomMatch) {
      return new Response("Not Found", {
        status: 404
      });
    }

    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Expected WebSocket", {
        status: 426
      });
    }


    const roomId = roomMatch[1];

    const id = env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);

    const stub = env.VOICE_ENTERPRISE_ROOM.get(id);

    return stub.fetch(request);
  }
};


export class VoiceEnterpriseRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
  }


  async fetch(request) {

    const url = new URL(request.url);

    const pair = new WebSocketPair();

    const [client, server] = Object.values(pair);


    const peerId =
      url.searchParams.get("peer_id")
      || crypto.randomUUID();


    const name =
      url.searchParams.get("name")
      || "USER";


    const loc =
      url.searchParams.get("loc")
      || "";


    this.ctx.acceptWebSocket(server);


    server.serializeAttachment({
      peerId,
      name,
      loc
    });


    this.broadcast(
      {
        type:"PEER_JOINED",
        peerId,
        name,
        loc
      },
      server
    );


    const peers =
      this.ctx
      .getWebSockets()
      .filter(s=>s!==server)
      .map(s=>s.deserializeAttachment()?.peerId)
      .filter(Boolean);


    server.send(JSON.stringify({
      type:"WELCOME",
      peerId,
      peers
    }));


    return new Response(null,{
      status:101,
      webSocket:client
    });
  }



  async webSocketMessage(ws,message){

    try{

      const data = JSON.parse(message);


      const att =
      ws.deserializeAttachment();


      if(data.type==="PING"){

        ws.send(JSON.stringify({
          type:"PONG"
        }));

        return;
      }


      const payload={
        ...data,
        sender:att.peerId,
        name:att.name,
        loc:att.loc
      };


      if(data.target){

        for(
          const s of this.ctx.getWebSockets()
        ){

          const a=s.deserializeAttachment();

          if(a?.peerId===data.target){

            s.send(JSON.stringify(payload));

          }

        }

      }else{

        this.broadcast(payload,ws);

      }


    }catch(e){}

  }




  async webSocketClose(ws){

    const att =
    ws.deserializeAttachment();


    if(att){

      this.broadcast({
        type:"PEER_LEFT",
        peerId:att.peerId
      });

    }

  }




  broadcast(msg,exclude){

    const raw=JSON.stringify(msg);


    for(
      const ws of this.ctx.getWebSockets()
    ){

      if(ws!==exclude){

        try{
          ws.send(raw);
        }
        catch(e){}

      }

    }

  }

}
