# Enterprise Cloudflare Worker Voice Server

Server komunikasi suara real-time berbasis arsitektur Cloudflare Workers modern, didukung oleh **Durable Objects**, **SQLite Storage Internal**, **WebSocket Hibernation API**, dan **WebRTC P2P/Mesh Signaling Core**.

## Fitur Utama:
- **Persistent SQLite Database:** Menyimpan log dan riwayat room secara permanen di edge.
- **WebSocket Hibernation:** Efisiensi tinggi tanpa membebani RAM edge saat idle.
- **Ping-Pong Keep-Alive:** Mencegah pemutusan koneksi otomatis oleh operator jaringan.
- **Full Frontend Client Included:** Antarmuka web bawaan server yang siap diuji langsung.

## Cara Deploy:
1. Pastikan Node.js terinstal.
2. Jalankan instalasi dependensi:
   ```bash
   npm install
