/**
 * Stream Code
 * Format: dvf1{sender}{startblock} or dvf1{sender}{startblock}x{duration}
 */

export const PREFIX = "dvf1";
export const ADDRESS_LENGTH = 42; // 0x + 40 hex chars

export interface ParsedStreamCode {
  senderAddress: string;
  startBlock: number;
  endBlock: number | null;
  isLive: boolean;
}

export interface ParseError {
  error: string;
}

export type ParseResult = ParsedStreamCode | ParseError;

// ============================================
// Creation (Sender)
// ============================================

export function create(senderAddress: string, startBlock: number): string {
  const sender = senderAddress.toLowerCase();
  return `${PREFIX}${sender}${startBlock}`;
}

export function createWithEnd(
  senderAddress: string,
  startBlock: number,
  endBlock: number
): string {
  const sender = senderAddress.toLowerCase();
  const duration = endBlock - startBlock;
  return `${PREFIX}${sender}${startBlock}x${duration}`;
}

// ============================================
// Parsing (Receiver)
// ============================================

export function parse(code: string): ParseResult {
  code = code.trim();

  if (!code.startsWith(PREFIX)) {
    return { error: "Invalid stream code: must start with dvf1" };
  }

  const remainder = code.slice(PREFIX.length);

  // Extract sender address (0x + 40 hex chars)
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

  // Check if there's a duration separator
  const xIndex = blockPart.indexOf("x");

  if (xIndex === -1) {
    // Live stream: dvf1{sender}{startblock}
    const startBlock = parseInt(blockPart, 10);
    if (isNaN(startBlock)) {
      return { error: "Invalid stream code: invalid start block" };
    }
    return {
      senderAddress: senderAddress.toLowerCase(),
      startBlock,
      endBlock: null,
      isLive: true,
    };
  } else {
    // Completed stream: dvf1{sender}{startblock}x{duration}
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
      isLive: false,
    };
  }
}
