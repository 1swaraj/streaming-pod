/**
 * Shared wallet + session-key + DVF transport logic for the uploader and
 * broadcaster pages. DOM-free — pages wire their own UI through callbacks.
 *
 * Model: a one-off "session key" is generated in the browser and persisted in
 * localStorage. It signs and broadcasts every DVF packet straight to the Monad
 * RPC via eth_sendRawTransaction — no per-packet wallet popups, and no
 * dependency on the wallet's chain support. A connected wallet is optional and
 * used only for one-click funding of the session key.
 */
import {
  createWalletClient, createPublicClient, http, custom, defineChain,
  toHex, parseGwei, parseEther, formatEther, formatGwei
} from 'https://esm.sh/viem';
import { privateKeyToAccount, generatePrivateKey } from 'https://esm.sh/viem/accounts';

export { parseEther, formatEther, formatGwei, parseGwei };

// Address every DVF packet is sent to (receivers scan sender -> this address).
export const DEST_ADDRESS = '0x6476660100000000000000000000000000000000';

// Resolve the target network. Defaults to Monad MAINNET (143). Override with
// localStorage.MONAD_CHAIN_ID (e.g. 10143 for testnet) and ETH_RPC_URL.
export function resolveTarget() {
  const id = parseInt(localStorage['MONAD_CHAIN_ID'] || '143', 10);
  const rpcOverride = localStorage['ETH_RPC_URL'] || null;
  const name = id === 143 ? 'Monad' : id === 10143 ? 'Monad Testnet' : `Chain ${id}`;
  const defaultRpc = id === 10143 ? 'https://testnet-rpc.monad.xyz' : 'https://rpc.monad.xyz';
  const explorer = id === 10143 ? 'https://testnet.monadexplorer.com' : 'https://monadexplorer.com';
  return {
    id,
    hexId: '0x' + id.toString(16),
    name,
    rpcUrl: rpcOverride || defaultRpc,
    explorer,
    symbol: 'MON'
  };
}

// Intrinsic gas INCLUDING the EIP-7623 calldata floor, which Monad enforces.
// For data-heavy txs the floor (21000 + 10*tokens, tokens = zeroBytes +
// 4*nonzeroBytes) dominates the legacy cost, so a flat ~20/byte limit gets
// rejected as "Gas limit too low".
export function intrinsicGas(data) {
  let zero = 0n, nonzero = 0n;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) zero++; else nonzero++;
  }
  const standard = 21000n + zero * 4n + nonzero * 16n;
  const floor = 21000n + (zero + nonzero * 4n) * 10n;
  return standard > floor ? standard : floor;
}

function gasForPacket(config, packetData) {
  if (config.gasLimit != null) return config.gasLimit;
  return intrinsicGas(packetData) + 5000n; // small safety buffer
}

// ============================================
// Packet State Machine
// ============================================
const PacketState = { SENDING: 'SENDING', PENDING: 'PENDING', CONFIRMED: 'CONFIRMED', FAILED: 'FAILED' };

class PacketStateMachine {
  constructor(nonce, packetData, config, callbacks, log, isFirst = false, isEnd = false) {
    this.nonce = nonce;
    this.packetData = packetData;
    this.config = config;
    this.callbacks = callbacks;
    this.log = log;
    this.isFirst = isFirst;
    this.isEnd = isEnd;

    this.state = PacketState.SENDING;
    this.txHashes = [];
    this.currentTxHash = null;
    this.priorityFee = config.basePriorityFee;
    this.retryCount = 0;
    this.lastSendTime = null;
  }

  _transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;
    this.log(`TX nonce=${this.nonce}: ${oldState} -> ${newState}`,
      newState === PacketState.CONFIRMED ? 'confirmed' :
      newState === PacketState.FAILED ? 'error' : 'pending');
  }

  async start(walletClient) {
    await this._broadcast(walletClient);
  }

  async _broadcast(walletClient) {
    try {
      const hexData = toHex(this.packetData);
      const txHash = await walletClient.sendTransaction({
        to: this.config.destAddress,
        data: hexData,
        nonce: this.nonce,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.priorityFee,
        gas: gasForPacket(this.config, this.packetData)
      });

      this.txHashes.push(txHash);
      this.currentTxHash = txHash;
      this.lastSendTime = Date.now();

      const retryLabel = this.retryCount > 0 ? ` (retry #${this.retryCount})` : '';
      this.log(`TX nonce=${this.nonce}${retryLabel}: ${txHash.slice(0, 18)}...`, 'pending');
      this._transitionTo(PacketState.PENDING);
    } catch (err) {
      this.log(`TX nonce=${this.nonce} ERROR: ${err.shortMessage || err.message}`, 'error');
      console.error('Transaction error:', err);
      if ((err.message || '').includes('nonce too low')) {
        this._transitionTo(PacketState.CONFIRMED);
        this.callbacks.onConfirmed(null);
      } else {
        this._transitionTo(PacketState.FAILED);
        this.callbacks.onFailed(err);
      }
    }
  }

  async _checkReceipt(publicClient, hash) {
    try { return await publicClient.getTransactionReceipt({ hash }); }
    catch { return null; }
  }

  _isTimedOut() {
    if (!this.lastSendTime) return false;
    return Date.now() - this.lastSendTime > this.config.confirmationTimeout;
  }

  _bumpPriorityFee() {
    this.priorityFee = this.priorityFee + this.config.priorityFeeIncrement;
    this.retryCount++;
  }

  isTerminal() {
    return this.state === PacketState.CONFIRMED || this.state === PacketState.FAILED;
  }

  async tick(publicClient, walletClient) {
    switch (this.state) {
      case PacketState.SENDING:
        break;
      case PacketState.PENDING:
        for (const hash of this.txHashes) {
          const receipt = await this._checkReceipt(publicClient, hash);
          if (receipt) {
            this._transitionTo(PacketState.CONFIRMED);
            this.log(`TX nonce=${this.nonce} CONFIRMED in block ${receipt.blockNumber}`, 'confirmed');
            this.callbacks.onConfirmed(receipt);
            return;
          }
        }
        if (this._isTimedOut()) {
          if (this.retryCount >= this.config.maxRetries) {
            this._transitionTo(PacketState.FAILED);
            this.log(`TX nonce=${this.nonce} MAX RETRIES reached`, 'error');
            this.callbacks.onFailed(new Error('Max retries exceeded'));
          } else {
            this._bumpPriorityFee();
            this._transitionTo(PacketState.SENDING);
            await this._broadcast(walletClient);
          }
        }
        break;
      case PacketState.CONFIRMED:
      case PacketState.FAILED:
        break;
    }
  }
}

// ============================================
// Blockchain Transport (manages packet state machines)
// ============================================
export class BlockchainTransport {
  constructor(config, publicClient, walletClient, account, onFirstConfirmation, onEndConfirmation, onStatsUpdate, log) {
    this.config = config;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.account = account;
    this.onFirstConfirmation = onFirstConfirmation;
    this.onEndConfirmation = onEndConfirmation;
    this.onStatsUpdate = onStatsUpdate || (() => {});
    this.log = log || (() => {});

    this.currentNonce = null;
    this.nonceInitialized = false;
    this.packets = new Map();
    this.totalRetries = 0;
    this.totalGasSpent = 0n;
    this.firstConfirmed = false;

    this.tickInterval = setInterval(() => this._tick(), 1000);
  }

  async initialize() {
    this.currentNonce = await this.publicClient.getTransactionCount({ address: this.account.address });
    this.nonceInitialized = true;
    this.log(`Initialized nonce: ${this.currentNonce}`, 'confirmed');
  }

  _handleConfirmed(machine, receipt) {
    if (receipt) this.totalGasSpent += receipt.gasUsed * receipt.effectiveGasPrice;
    this.totalRetries += machine.retryCount;
    this.onStatsUpdate();
    if (machine.isFirst && !this.firstConfirmed) {
      this.firstConfirmed = true;
      if (this.onFirstConfirmation && receipt) this.onFirstConfirmation(receipt.blockNumber);
    }
    if (machine.isEnd && this.onEndConfirmation && receipt) this.onEndConfirmation(receipt.blockNumber);
  }

  _handleFailed(machine, error) {
    this.totalRetries += machine.retryCount;
    this.onStatsUpdate();
    console.error(`Packet nonce=${machine.nonce} failed:`, error);
  }

  async send(packetData, isFirst = false, isEnd = false) {
    if (!this.nonceInitialized) await this.initialize();
    const nonce = this.currentNonce;
    this.currentNonce++;
    const machine = new PacketStateMachine(nonce, packetData, this.config, {
      onConfirmed: (receipt) => this._handleConfirmed(machine, receipt),
      onFailed: (error) => this._handleFailed(machine, error)
    }, this.log, isFirst, isEnd);
    this.packets.set(nonce, machine);
    this.onStatsUpdate();
    await machine.start(this.walletClient);
  }

  async _tick() {
    for (const machine of this.packets.values()) {
      if (!machine.isTerminal()) await machine.tick(this.publicClient, this.walletClient);
    }
    this.onStatsUpdate();
  }

  getPendingCount() {
    return [...this.packets.values()].filter(m => m.state === PacketState.SENDING || m.state === PacketState.PENDING).length;
  }
  getConfirmedCount() {
    return [...this.packets.values()].filter(m => m.state === PacketState.CONFIRMED).length;
  }
  getRetryCount() { return this.totalRetries; }
  getTotalGasSpent() { return this.totalGasSpent; }
  getSenderAddress() { return this.account.address; }
  close() { clearInterval(this.tickInterval); }
}

// ============================================
// WalletSession — session key lifecycle + funding
// ============================================
export class WalletSession {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.target = resolveTarget();
    this.symbol = this.target.symbol;
    this.activeChain = defineChain({
      id: this.target.id,
      name: this.target.name,
      nativeCurrency: { name: this.symbol, symbol: this.symbol, decimals: 18 },
      rpcUrls: { default: { http: [this.target.rpcUrl] } }
    });

    this.sessionAccount = null;
    this.publicClient = null;
    this.sessionWalletClient = null;
    this.funderWalletClient = null;
    this.funderAddress = null;
    this.sessionBalance = 0n;
    this.funderBalance = 0n;
    this.storageKey = 'DVF_SESSION_KEY';

    // Live config object shared (by reference) with every transport, so
    // refreshFees() updates the fees used by in-flight sends.
    this.config = {
      destAddress: DEST_ADDRESS,
      maxFeePerGas: parseGwei('50'),
      basePriorityFee: parseGwei('1'),
      priorityFeeIncrement: parseGwei('0.1'),
      gasLimit: null,            // null -> per-packet EIP-7623 intrinsic gas
      confirmationTimeout: 3000,
      maxRetries: 10
    };
  }

  init() {
    this.loadOrCreateKey();
    this._buildClients();
  }

  get sessionAddress() { return this.sessionAccount ? this.sessionAccount.address : null; }

  loadOrCreateKey() {
    let pk = localStorage[this.storageKey];
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      pk = generatePrivateKey();
      localStorage[this.storageKey] = pk;
    }
    this.sessionAccount = privateKeyToAccount(pk);
    return this.sessionAccount;
  }

  resetKey() {
    localStorage.removeItem(this.storageKey);
    this.loadOrCreateKey();
    this._buildClients();
  }

  _buildClients() {
    // Reads + the session key's chunk txs go straight to the Monad RPC.
    this.publicClient = createPublicClient({ chain: this.activeChain, transport: http(this.target.rpcUrl) });
    this.sessionWalletClient = createWalletClient({
      account: this.sessionAccount, chain: this.activeChain, transport: http(this.target.rpcUrl)
    });
    if (typeof window !== 'undefined' && window.ethereum && this.funderAddress) {
      this.funderWalletClient = createWalletClient({
        account: this.funderAddress, chain: this.activeChain, transport: custom(window.ethereum)
      });
    }
  }

  async ensureChain() {
    const t = this.target;
    const current = parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
    if (current === t.id) return;
    this.log(`Wallet on chain ${current}; switching to ${t.name} (${t.id})…`, 'pending');
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: t.hexId }] });
    } catch (err) {
      const code = err.code ?? err?.cause?.code;
      if (code === 4902 || /unrecognized chain|add this network/i.test(err.message || '')) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: t.hexId,
            chainName: t.name,
            nativeCurrency: { name: t.symbol, symbol: t.symbol, decimals: 18 },
            rpcUrls: [t.rpcUrl],
            blockExplorerUrls: [t.explorer]
          }]
        });
      } else throw err;
    }
  }

  async connect() {
    if (typeof window === 'undefined' || !window.ethereum) throw new Error('No injected wallet found.');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    this.funderAddress = accounts[0];
    await this.ensureChain();
    const chainId = parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
    if (chainId !== this.target.id) throw new Error(`Switch your wallet to ${this.target.name} (chain ${this.target.id}).`);
    this._buildClients();
    return this.funderAddress;
  }

  async fund(amountEther) {
    if (!this.funderWalletClient) throw new Error('Connect a wallet first.');
    const value = parseEther(String(amountEther).trim());
    if (value <= 0n) throw new Error('Amount must be > 0');
    const gasBuffer = 30000n * (this.config.maxFeePerGas || parseGwei('2'));
    if (value + gasBuffer > this.funderBalance) {
      throw new Error(`Not enough in wallet: balance ${formatEther(this.funderBalance)} ${this.symbol}.`);
    }
    const hash = await this.funderWalletClient.sendTransaction({ to: this.sessionAccount.address, value });
    await this.publicClient.waitForTransactionReceipt({ hash });
    await this.refreshBalance();
    return hash;
  }

  async refreshBalance() {
    if (!this.publicClient) return;
    if (this.sessionAccount) this.sessionBalance = await this.publicClient.getBalance({ address: this.sessionAccount.address });
    if (this.funderAddress) this.funderBalance = await this.publicClient.getBalance({ address: this.funderAddress });
  }

  async refreshFees() {
    if (!this.publicClient) return;
    try {
      const gp = await this.publicClient.getGasPrice();
      this.config.maxFeePerGas = gp * 2n;
      this.config.basePriorityFee = gp / 5n > 0n ? gp / 5n : 1n;
      this.config.priorityFeeIncrement = this.config.basePriorityFee;
      this.log(`Network gas ~${formatGwei(gp)} gwei → maxFee ${formatGwei(this.config.maxFeePerGas)} gwei`, 'confirmed');
    } catch (err) {
      this.log(`Gas price fetch failed (${err.shortMessage || err.message}); using defaults`, 'retry');
    }
  }

  // Worst-case (all-nonzero) EIP-7623 floor ≈ 21000 + 40*bytes per tx.
  estimateUploadCost(fileSize, chunkSize = 64 * 1024) {
    const chunks = BigInt(Math.ceil(fileSize / chunkSize));
    const totalGas = chunks * 21000n + BigInt(fileSize) * 40n;
    return totalGas * (this.config.maxFeePerGas || parseGwei('2'));
  }

  maxFundable() {
    const gasBuffer = 30000n * (this.config.maxFeePerGas || parseGwei('2'));
    return this.funderBalance > gasBuffer ? this.funderBalance - gasBuffer : 0n;
  }

  createTransport({ onFirstConfirmation, onEndConfirmation, onStats } = {}) {
    return new BlockchainTransport(
      this.config, this.publicClient, this.sessionWalletClient, this.sessionAccount,
      onFirstConfirmation, onEndConfirmation, onStats, this.log
    );
  }

  isReady() { return !!this.sessionWalletClient && this.sessionBalance > 0n; }
}
