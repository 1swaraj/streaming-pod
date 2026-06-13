# Video over blockchain

Yes, you can stream live video over a blockchain.

Demo:
https://danielvf.github.io/blockchain-streaming/public/receiver.html

Use streamcode: dvf10x0f18d1eae85b78b57f17b4a31a8f3099e6be644f50621047


DVF (Discretized Video Format) is a simple binary protocol designed for streaming video data over unreliable, potentially out-of-order transport layers.

Works both for streaming video and filesharing.

## Pages

- `public/broadcaster.html` — live camera broadcast over the chain.
- `public/uploader.html` — upload a video **file** and store it on-chain, then share a stream code to replay it.
- `public/receiver.html` — paste a stream code to watch. Live broadcasts play progressively via MediaSource; uploaded files (any format) download fully then play as a Blob (selected automatically when the metadata carries a `fileName`).

### Uploading a file

On load the page generates a one-off **session key** (stored in this browser's `localStorage`) and shows its address. The session key signs and broadcasts every chunk itself via the Monad RPC (`eth_sendRawTransaction`) — no per-chunk popups, and no dependency on the wallet's chain support.

1. Open `public/uploader.html`.
2. **Fund the session key.** Either click **Connect wallet** (switches the wallet to Monad and funds in one prompt), or just send MON to the session address from any wallet and click **refresh**. It's a hot key, so only fund what you'll spend. The page shows the session balance and an estimated max cost for the selected file; **max** fills the largest amount a connected wallet can afford.
3. Pick a video, click **Upload to Blockchain**. The file is sent as a DVF metadata packet (with `fileName`/`fileSize`) followed by byte-contiguous stream chunks and a final end packet.
4. Share the resulting stream code, or open it directly in the receiver via the **Watch in receiver** link.

Both pages default to **Monad mainnet** (chain id `143`, RPC `https://rpc.monad.xyz`). Reads and chunk transactions go straight to that RPC; the wallet is only used for the optional one-click funding transfer. Chunk fees are read live from the chain. Override the network with `localStorage.MONAD_CHAIN_ID` (e.g. `10143` for testnet) and `localStorage.ETH_RPC_URL` (e.g. a local Monad node).

> Mainnet uses **real MON**. Storing video as calldata is genuinely expensive (16 gas per non-zero byte is a fixed EVM cost) — check the "Est. max cost" before funding, and start with a small clip.

## Binary Packet Format

All packets share a common 5-byte header: 

```
┌─────────────────┬─────────────┬─────────────┐
│ Magic (3 bytes) │ Version (1) │ Type (1)    │
│ 0x64 0x76 0x66  │ 0x01        │ 0x00-0x02   │
│ "dvf" in UTF-8  │             │             │
└─────────────────┴─────────────┴─────────────┘
```

### Header Fields

| Field   | Size    | Value      | Description                          |
|---------|---------|------------|--------------------------------------|
| Magic   | 3 bytes | `0x647666` | ASCII "dvf" - identifies DVF packets |
| Version | 1 byte  | `0x01`     | Protocol version                     |
| Type    | 1 byte  | `0x00-0x02`| Packet type identifier               |

### Packet Types

A stream/file must begin with a 0x00 Metadata packet.

Any number of 0x01 Stream Data packets may follow.

A 0x02 End of Stream packet closes the stream, and no other packets may follow. Streams are implied to close after some period of time have passed without a packet.


#### Type 0x00: Metadata

Contains JSON-encoded metadata about the stream. 

```
┌──────────────────┬─────────────────────────┐
│ Header (5 bytes) │ JSON Payload (variable) │
└──────────────────┴─────────────────────────┘
```

**JSON Payload Fields:**

| Field             | Type   | Description                              |
|-------------------|--------|------------------------------------------|
| `mimeType`        | string | Media MIME type with codecs (e.g., `video/webm;codecs=vp8,opus`) |
| `videoBitsPerSecond` | number | Video bitrate in bits per second      |
| `fileName`        | string | *(optional)* Original file name. When present, the receiver treats the stream as a downloadable file and plays it as a Blob (any format) instead of progressive MediaSource. |
| `fileSize`        | number | *(optional)* Total file size in bytes, used for download progress. |

**Example JSON:**
```json
{
  "mimeType": "video/webm;codecs=vp8,opus",
  "videoBitsPerSecond": 1500000,
}
```

#### Type 0x01: Stream Data

Contains a chunk of video stream data with its position. 

```
┌──────────────────┬──────────────────┬─────────────────────┐
│ Header (5 bytes) │ Position (8 bytes)│ Chunk Data (variable) │
└──────────────────┴──────────────────┴─────────────────────┘
```

**Position Field:**
- 8 bytes, unsigned 64-bit integer
- **Little-endian** byte order
- Represents the byte offset of this chunk in the complete stream
- First chunk has position 0

#### Type 0x02: End of Stream

Signals the end of the stream.  May contain final chunk data. Zero length chunk data is vaild.

```
┌──────────────────┬──────────────────┬─────────────────────────┐
│ Header (5 bytes) │ Position (8 bytes)│ Final Data (0+ bytes)  │
└──────────────────┴──────────────────┴─────────────────────────┘
