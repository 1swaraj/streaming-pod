/**
 * DVF (Discretized Video Format) Protocol
 * Binary protocol for streaming video data over unreliable transport layers.
 */

export const MAGIC = new Uint8Array([0x64, 0x76, 0x66]); // "dvf"
export const VERSION = 0x01;

export const TYPE_METADATA = 0x00;
export const TYPE_STREAM = 0x01;
export const TYPE_END = 0x02;

export const HEADER_SIZE = 5;
export const POSITION_SIZE = 8;

export interface StreamMetadata {
  mimeType: string;
  videoBitsPerSecond: number;
  startTime: number;
  // Optional file metadata (set when sharing a file rather than a live stream).
  // When fileName is present, receivers download the whole file and play it as
  // a Blob, which supports any format the browser can decode.
  fileName?: string;
  fileSize?: number;
}

export interface ParsedMetadataPacket {
  type: typeof TYPE_METADATA;
  version: number;
  metadata: StreamMetadata;
}

export interface ParsedStreamPacket {
  type: typeof TYPE_STREAM;
  version: number;
  position: number;
  data: Uint8Array;
}

export interface ParsedEndPacket {
  type: typeof TYPE_END;
  version: number;
  position: number;
  data: Uint8Array;
}

export interface ParseError {
  error: string;
}

export type ParsedPacket = ParsedMetadataPacket | ParsedStreamPacket | ParsedEndPacket | ParseError;

// ============================================
// Encoding (Sender)
// ============================================

export function createHeader(type: number): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  header.set(MAGIC, 0);
  header[3] = VERSION;
  header[4] = type;
  return header;
}

export function encodePosition(position: number): Uint8Array {
  const buffer = new ArrayBuffer(POSITION_SIZE);
  const view = new DataView(buffer);
  // Little-endian uint64
  view.setUint32(0, position & 0xffffffff, true);
  view.setUint32(4, Math.floor(position / 0x100000000), true);
  return new Uint8Array(buffer);
}

export function createMetadataPacket(metadata: StreamMetadata): Uint8Array {
  const header = createHeader(TYPE_METADATA);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const packet = new Uint8Array(header.length + jsonBytes.length);
  packet.set(header, 0);
  packet.set(jsonBytes, header.length);
  return packet;
}

export function createStreamPacket(position: number, data: Uint8Array | ArrayBuffer): Uint8Array {
  const header = createHeader(TYPE_STREAM);
  const posBytes = encodePosition(position);
  const dataBytes = new Uint8Array(data);
  const packet = new Uint8Array(header.length + posBytes.length + dataBytes.length);
  packet.set(header, 0);
  packet.set(posBytes, header.length);
  packet.set(dataBytes, header.length + posBytes.length);
  return packet;
}

export function createEndPacket(position: number, data: Uint8Array | ArrayBuffer | null = null): Uint8Array {
  const header = createHeader(TYPE_END);
  const posBytes = encodePosition(position);
  let packet: Uint8Array;
  if (data && (data as Uint8Array).byteLength > 0) {
    const dataBytes = new Uint8Array(data);
    packet = new Uint8Array(header.length + posBytes.length + dataBytes.length);
    packet.set(header, 0);
    packet.set(posBytes, header.length);
    packet.set(dataBytes, header.length + posBytes.length);
  } else {
    packet = new Uint8Array(header.length + posBytes.length);
    packet.set(header, 0);
    packet.set(posBytes, header.length);
  }
  return packet;
}

// ============================================
// Decoding (Receiver)
// ============================================

export function validateMagic(data: Uint8Array): boolean {
  return (
    data.length >= HEADER_SIZE &&
    data[0] === 0x64 &&
    data[1] === 0x76 &&
    data[2] === 0x66
  );
}

export function decodePosition(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, POSITION_SIZE);
  const lower = view.getUint32(0, true);
  const upper = view.getUint32(4, true);
  return upper * 0x100000000 + lower;
}

export function parse(data: Uint8Array): ParsedPacket {
  if (!validateMagic(data)) {
    return { error: "Invalid magic bytes" };
  }

  const version = data[3];
  if (version !== VERSION) {
    return { error: `Unknown version: ${version}` };
  }

  const type = data[4];

  switch (type) {
    case TYPE_METADATA: {
      const jsonBytes = data.slice(HEADER_SIZE);
      const jsonStr = new TextDecoder().decode(jsonBytes);
      const metadata = JSON.parse(jsonStr) as StreamMetadata;
      return { type: TYPE_METADATA, version, metadata };
    }

    case TYPE_STREAM: {
      if (data.length < HEADER_SIZE + POSITION_SIZE) {
        return { error: "Stream packet too short" };
      }
      const position = decodePosition(data, HEADER_SIZE);
      const packetData = data.slice(HEADER_SIZE + POSITION_SIZE);
      return { type: TYPE_STREAM, version, position, data: packetData };
    }

    case TYPE_END: {
      if (data.length < HEADER_SIZE + POSITION_SIZE) {
        return { error: "End packet too short" };
      }
      const position = decodePosition(data, HEADER_SIZE);
      const packetData =
        data.length > HEADER_SIZE + POSITION_SIZE
          ? data.slice(HEADER_SIZE + POSITION_SIZE)
          : new Uint8Array(0);
      return { type: TYPE_END, version, position, data: packetData };
    }

    default:
      return { error: `Unknown packet type: ${type}` };
  }
}
