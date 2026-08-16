import { DurableObject } from "cloudflare:workers";


export default {

  async fetch(request, env) {

    const url = new URL(request.url);
    const path = url.pathname;


    // Health check
    if (path === "/") {
      return new Response("HTM Worker Online", {
        status: 200
      });
    }


    // Room websocket endpoint
    const roomMatch = path.match(/^\/room\/([^\/]+)$/);

    if (!roomMatch) {
      return new Response("Not Found", {
        status: 404
      });
    }


    // Pastikan websocket
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Expected WebSocket", {
        status: 426
      });
    }


    const roomId = decodeURIComponent(roomMatch[1]);


    const id =
      env.VOICE_ENTERPRISE_ROOM.idFromName(roomId);


    const room =
      env.VOICE_ENTERPRISE_ROOM.get(id);


    return room.fetch(request);

  }

};



export class VoiceEnterpriseRoom extends DurableObject {


  constructor(ctx, env) {

    super(ctx, env);

  }



  async fetch(request) {

    const url = new URL(request.url);


    const peerId =
      url.searchParams.get("peer_id")
      || crypto.randomUUID();


    const name =
      url.searchParams.get("name")
      || "USER";


    const loc =
      url.searchParams.get("loc")
      || "";



    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];



    this.ctx.acceptWebSocket(server);



    server.serializeAttachment({

      peerId,
      name,
      loc

    });



    // Kirim daftar user lama
    const existingPeers =
      this.ctx
      .getWebSockets()
      .filter(ws => ws !== server)
      .map(ws => {

        const data =
          ws.deserializeAttachment();

        return data
          ? {
              peerId:data.peerId,
              name:data.name,
              loc:data.loc
            }
          : null;

      })
      .filter(Boolean);



    server.send(JSON.stringify({

      type:"WELCOME",

      peerId,

      peers:existingPeers

    }));




    // Beritahu user lain
    this.broadcast({

      type:"PEER_JOINED",

      peerId,

      name,

      loc

    }, server);




    return new Response(null, {

      status:101,

      webSocket:client

    });

  }






  async webSocketMessage(ws,message) {


    try {


      const data =
        JSON.parse(message);



      const sender =
        ws.deserializeAttachment();



      if (!sender) return;




      // heartbeat
      if(data.type === "PING") {

        ws.send(JSON.stringify({

          type:"PONG"

        }));

        return;

      }





      const payload = {

        ...data,

        sender: sender.peerId,

        name: sender.name,

        loc: sender.loc

      };






      // pesan private
      if(data.target) {


        for(
          const client of this.ctx.getWebSockets()
        ) {


          const target =
            client.deserializeAttachment();



          if(
            target &&
            target.peerId === data.target
          ) {


            try {

              client.send(
                JSON.stringify(payload)
              );

            } catch(e){}


          }


        }


        return;

      }







      // broadcast room
      this.broadcast(payload, ws);




    } catch(error) {


      console.log(
        "WebSocket Message Error",
        error
      );


    }


  }








  async webSocketClose(ws) {


    const data =
      ws.deserializeAttachment();



    if(!data) return;




    this.broadcast({

      type:"PEER_LEFT",

      peerId:data.peerId

    }, ws);



  }








  async webSocketError(ws,error) {


    console.log(
      "WebSocket Error",
      error
    );


  }








  broadcast(message,exclude=null) {


    const raw =
      JSON.stringify(message);



    for(
      const ws of this.ctx.getWebSockets()
    ) {


      if(ws === exclude)
        continue;



      try {

        ws.send(raw);

      }

      catch(e){}


    }


  }


}
