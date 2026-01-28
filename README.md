# Video over blockchain

Yes, you can stream live video over a blockchain.

Demo:
https://danielvf.github.io/blockchain-streaming/public/receiver.html

Use streamcode: dvf10x0f18d1eae85b78b57f17b4a31a8f3099e6be644f50621047


DVF (Discretized Video Format) is a simple binary protocol designed for streaming video data over unreliable, potentially out-of-order transport layers.

Works both for streaming video and filesharing.

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

This can easily be extended to include a filename for filesharing.

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
