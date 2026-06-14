var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/dvf-protocol.ts
var exports_dvf_protocol = {};
__export(exports_dvf_protocol, {
  validateMagic: () => validateMagic,
  parse: () => parse,
  encodePosition: () => encodePosition,
  decodePosition: () => decodePosition,
  createStreamPacket: () => createStreamPacket,
  createMetadataPacket: () => createMetadataPacket,
  createHeader: () => createHeader,
  createEndPacket: () => createEndPacket,
  VERSION: () => VERSION,
  TYPE_STREAM: () => TYPE_STREAM,
  TYPE_METADATA: () => TYPE_METADATA,
  TYPE_END: () => TYPE_END,
  POSITION_SIZE: () => POSITION_SIZE,
  MAGIC: () => MAGIC,
  HEADER_SIZE: () => HEADER_SIZE
});
var MAGIC = new Uint8Array([100, 118, 102]);
var VERSION = 1;
var TYPE_METADATA = 0;
var TYPE_STREAM = 1;
var TYPE_END = 2;
var HEADER_SIZE = 5;
var POSITION_SIZE = 8;
function createHeader(type) {
  const header = new Uint8Array(HEADER_SIZE);
  header.set(MAGIC, 0);
  header[3] = VERSION;
  header[4] = type;
  return header;
}
function encodePosition(position) {
  const buffer = new ArrayBuffer(POSITION_SIZE);
  const view = new DataView(buffer);
  view.setUint32(0, position & 4294967295, true);
  view.setUint32(4, Math.floor(position / 4294967296), true);
  return new Uint8Array(buffer);
}
function createMetadataPacket(metadata) {
  const header = createHeader(TYPE_METADATA);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const packet = new Uint8Array(header.length + jsonBytes.length);
  packet.set(header, 0);
  packet.set(jsonBytes, header.length);
  return packet;
}
function createStreamPacket(position, data) {
  const header = createHeader(TYPE_STREAM);
  const posBytes = encodePosition(position);
  const dataBytes = new Uint8Array(data);
  const packet = new Uint8Array(header.length + posBytes.length + dataBytes.length);
  packet.set(header, 0);
  packet.set(posBytes, header.length);
  packet.set(dataBytes, header.length + posBytes.length);
  return packet;
}
function createEndPacket(position, data = null) {
  const header = createHeader(TYPE_END);
  const posBytes = encodePosition(position);
  let packet;
  if (data && data.byteLength > 0) {
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
function validateMagic(data) {
  return data.length >= HEADER_SIZE && data[0] === 100 && data[1] === 118 && data[2] === 102;
}
function decodePosition(data, offset) {
  const view = new DataView(data.buffer, data.byteOffset + offset, POSITION_SIZE);
  const lower = view.getUint32(0, true);
  const upper = view.getUint32(4, true);
  return upper * 4294967296 + lower;
}
function parse(data) {
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
      const metadata = JSON.parse(jsonStr);
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
      const packetData = data.length > HEADER_SIZE + POSITION_SIZE ? data.slice(HEADER_SIZE + POSITION_SIZE) : new Uint8Array(0);
      return { type: TYPE_END, version, position, data: packetData };
    }
    default:
      return { error: `Unknown packet type: ${type}` };
  }
}
// src/stream-code.ts
var exports_stream_code = {};
__export(exports_stream_code, {
  parse: () => parse2,
  createWithEnd: () => createWithEnd,
  create: () => create,
  PREFIX: () => PREFIX,
  ADDRESS_LENGTH: () => ADDRESS_LENGTH
});
var PREFIX = "dvf1";
var ADDRESS_LENGTH = 42;
function create(senderAddress, startBlock) {
  const sender = senderAddress.toLowerCase();
  return `${PREFIX}${sender}${startBlock}`;
}
function createWithEnd(senderAddress, startBlock, endBlock) {
  const sender = senderAddress.toLowerCase();
  const duration = endBlock - startBlock;
  return `${PREFIX}${sender}${startBlock}x${duration}`;
}
function parse2(code) {
  code = code.trim();
  if (!code.startsWith(PREFIX)) {
    return { error: "Invalid stream code: must start with dvf1" };
  }
  const remainder = code.slice(PREFIX.length);
  if (remainder.length < ADDRESS_LENGTH) {
    return { error: "Invalid stream code: address too short" };
  }
  const senderAddress = remainder.slice(0, ADDRESS_LENGTH);
  if (!/^0x[a-fA-F0-9]{40}$/.test(senderAddress)) {
    return { error: "Invalid stream code: invalid address format" };
  }
  const blockPart = remainder.slice(ADDRESS_LENGTH);
  if (!blockPart) {
    return { error: "Invalid stream code: missing block number" };
  }
  const xIndex = blockPart.indexOf("x");
  if (xIndex === -1) {
    const startBlock = parseInt(blockPart, 10);
    if (isNaN(startBlock)) {
      return { error: "Invalid stream code: invalid start block" };
    }
    return {
      senderAddress: senderAddress.toLowerCase(),
      startBlock,
      endBlock: null,
      isLive: true
    };
  } else {
    const startBlockStr = blockPart.slice(0, xIndex);
    const durationStr = blockPart.slice(xIndex + 1);
    const startBlock = parseInt(startBlockStr, 10);
    const duration = parseInt(durationStr, 10);
    if (isNaN(startBlock) || isNaN(duration)) {
      return { error: "Invalid stream code: invalid block numbers" };
    }
    return {
      senderAddress: senderAddress.toLowerCase(),
      startBlock,
      endBlock: startBlock + duration,
      isLive: false
    };
  }
}
// src/reassembly-buffer.ts
class ReassemblyBuffer {
  chunks = new Map;
  _reassembledPosition = 0;
  _totalLength = null;
  _endReceived = false;
  _outOfOrderCount = 0;
  _receivedBytes = 0;
  get reassembledPosition() {
    return this._reassembledPosition;
  }
  get totalLength() {
    return this._totalLength;
  }
  get endReceived() {
    return this._endReceived;
  }
  get outOfOrderCount() {
    return this._outOfOrderCount;
  }
  addChunk(position, data, isEnd = false) {
    const bytes = new Uint8Array(data);
    if (position < this._reassembledPosition)
      return;
    const isNew = !this.chunks.has(position);
    if (isNew) {
      if (position > this._reassembledPosition)
        this._outOfOrderCount++;
      this._receivedBytes += bytes.byteLength;
    }
    this.chunks.set(position, { data: bytes, isEnd });
    if (isEnd) {
      this._endReceived = true;
      this._totalLength = position + bytes.byteLength;
    }
  }
  getContiguousData() {
    const result = [];
    let currentPos = this._reassembledPosition;
    while (this.chunks.has(currentPos)) {
      const chunk = this.chunks.get(currentPos);
      result.push(chunk.data);
      const chunkLen = chunk.data.byteLength;
      if (chunkLen === 0) {
        this.chunks.delete(currentPos);
        break;
      }
      const consumedPos = currentPos;
      currentPos = currentPos + chunkLen;
      this.chunks.delete(consumedPos);
    }
    if (result.length > 0) {
      this._reassembledPosition = currentPos;
      const totalLength = result.reduce((sum, arr) => sum + arr.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of result) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      return combined;
    }
    return null;
  }
  isComplete() {
    return this._endReceived && this._reassembledPosition === this._totalLength;
  }
  getStats() {
    return {
      reassembledPosition: this._reassembledPosition,
      totalLength: this._totalLength,
      receivedBytes: this._receivedBytes,
      chunkCount: this.chunks.size,
      outOfOrderCount: this._outOfOrderCount,
      isComplete: this.isComplete()
    };
  }
  getChunkRanges() {
    const ranges = [];
    if (this._reassembledPosition > 0) {
      ranges.push({ start: 0, end: this._reassembledPosition });
    }
    for (const [pos, chunk] of this.chunks) {
      ranges.push({ start: pos, end: pos + chunk.data.byteLength });
    }
    return ranges.sort((a, b) => a.start - b.start);
  }
  reset() {
    this.chunks.clear();
    this._reassembledPosition = 0;
    this._totalLength = null;
    this._endReceived = false;
    this._outOfOrderCount = 0;
    this._receivedBytes = 0;
  }
}
export {
  exports_stream_code as StreamCode,
  ReassemblyBuffer,
  exports_dvf_protocol as DVFProtocol
};
