/**
 * Out-of-Order Reassembly Buffer
 * Handles packets that arrive out of order (common with blockchain due to variable transaction inclusion times).
 */

export interface ChunkRange {
  start: number;
  end: number;
}

export interface BufferStats {
  reassembledPosition: number;
  totalLength: number | null;
  receivedBytes: number;
  chunkCount: number;
  outOfOrderCount: number;
  isComplete: boolean;
}

interface StoredChunk {
  data: Uint8Array;
  isEnd: boolean;
}

export class ReassemblyBuffer {
  private chunks: Map<number, StoredChunk> = new Map();
  private _reassembledPosition: number = 0;
  private _totalLength: number | null = null;
  private _endReceived: boolean = false;
  private _outOfOrderCount: number = 0;
  // Total distinct bytes ever admitted (delivered + currently buffered).
  // Tracked incrementally so it survives eviction and getStats stays O(1).
  private _receivedBytes: number = 0;

  get reassembledPosition(): number {
    return this._reassembledPosition;
  }

  get totalLength(): number | null {
    return this._totalLength;
  }

  get endReceived(): boolean {
    return this._endReceived;
  }

  get outOfOrderCount(): number {
    return this._outOfOrderCount;
  }

  addChunk(position: number, data: Uint8Array | ArrayBuffer, isEnd: boolean = false): void {
    const bytes = new Uint8Array(data);

    // The contiguous region behind the cursor has already been delivered and
    // its payloads evicted to free memory (see getContiguousData). A re-seen
    // packet from that region is inert — drop it so it can't re-grow the Map.
    if (position < this._reassembledPosition) return;

    const isNew = !this.chunks.has(position);
    if (isNew) {
      if (position > this._reassembledPosition) this._outOfOrderCount++;
      this._receivedBytes += bytes.byteLength;
    }

    this.chunks.set(position, { data: bytes, isEnd });

    if (isEnd) {
      this._endReceived = true;
      this._totalLength = position + bytes.byteLength;
    }
  }

  getContiguousData(): Uint8Array | null {
    const result: Uint8Array[] = [];
    let currentPos = this._reassembledPosition;

    while (this.chunks.has(currentPos)) {
      const chunk = this.chunks.get(currentPos)!;
      result.push(chunk.data);
      const chunkLen = chunk.data.byteLength;
      if (chunkLen === 0) {
        // Avoid infinite loop on empty chunks - remove and break
        this.chunks.delete(currentPos);
        break;
      }
      const consumedPos = currentPos;
      currentPos = currentPos + chunkLen;
      // Evict the delivered payload: it's already copied into `result` (and
      // handed to the caller below), and the cursor only moves forward, so it
      // can never be needed again. Without this the Map retains the entire
      // stream and large/long streams OOM the tab.
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

  isComplete(): boolean {
    return this._endReceived && this._reassembledPosition === this._totalLength;
  }

  getStats(): BufferStats {
    return {
      reassembledPosition: this._reassembledPosition,
      totalLength: this._totalLength,
      receivedBytes: this._receivedBytes,
      chunkCount: this.chunks.size,
      outOfOrderCount: this._outOfOrderCount,
      isComplete: this.isComplete(),
    };
  }

  getChunkRanges(): ChunkRange[] {
    const ranges: ChunkRange[] = [];
    // Delivered, contiguous region. Its individual chunks have been evicted to
    // free memory, so represent it as one solid range up to the cursor.
    if (this._reassembledPosition > 0) {
      ranges.push({ start: 0, end: this._reassembledPosition });
    }
    // Out-of-order chunks still buffered ahead of the cursor.
    for (const [pos, chunk] of this.chunks) {
      ranges.push({ start: pos, end: pos + chunk.data.byteLength });
    }
    return ranges.sort((a, b) => a.start - b.start);
  }

  reset(): void {
    this.chunks.clear();
    this._reassembledPosition = 0;
    this._totalLength = null;
    this._endReceived = false;
    this._outOfOrderCount = 0;
    this._receivedBytes = 0;
  }
}
