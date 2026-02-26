import * as fs from "fs";
import * as path from "path";
import { Wallet, ethers } from "ethers";
import axios from "axios";
import type {
  MarketInfo,
  TrackedOrder,
  TrackedSellInfo,
  OrderResult,
  BothSidedOrders,
  ApiKeyCreds,
  IClobClient,
  OrderArgs,
  OrderOptions,
  BalanceAllowance,
} from "./types";
import { config } from "../config";

const USDC_ADDRESS = ethers.utils.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
const CLOB_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const POLYGON_RPC = "https://polygon.drpc.org";
const MIN_USDC_ALLOWANCE_USD = 10;

const MIN_SHARE_SIZE = 5;
/** Default: enter/sell even 20s before close so you don't hold into resolution. Set MIN_SECONDS_TO_ENTER for a different buffer. */
const DEFAULT_MIN_SECONDS_TO_ENTER = 20;
/** Don't trade markets that expire in less than this many seconds (default 3 min). */
const DEFAULT_MIN_SECONDS_BEFORE_EXPIRY = 299;
/** When this many seconds left before market end, cancel resting SELL and place aggressive exit so we don't hold into resolution. */
const EXIT_BEFORE_CLOSE_SECONDS = 20;
/** Price used for emergency exit SELL when market is about to close (sell at this to get out). */
const AGGRESSIVE_EXIT_PRICE = 0.4;
const POLYGON_GAS_PRICE_GWEI = 50;
/** Default delay (ms) after detecting a fill before placing SELL, so CLOB can credit outcome tokens */
const DEFAULT_SELL_DELAY_MS = 10000;

const USDC_APPROVAL_AMOUNT = "10000";
const BTC_5M_SERIES_ID = "10684";
const BTC_5M_SLUG = "btc-updown-5m";

function ts(): string {
  return new Date().toISOString();
}

let LOG_FILE_PATH: string | null = null;
const MARKET_LOGS_DIR = "logs/markets";

function setLogFile(envPath: string | undefined): void {
  const p = envPath?.trim();
  if (!p) return;
  LOG_FILE_PATH = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const dir = path.dirname(LOG_FILE_PATH);
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

function getMarketLogPath(marketKey: string): string {
  const dir = path.isAbsolute(MARKET_LOGS_DIR) ? MARKET_LOGS_DIR : path.resolve(process.cwd(), MARKET_LOGS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${marketKeyToSafeFilename(marketKey)}.log`);
}

function writeToMarketLog(marketKey: string, level: string, section: string, msg: string): void {
  try {
    const filePath = getMarketLogPath(marketKey);
    fs.appendFileSync(filePath, `[${ts()}] [${level}] [${section}] ${msg}\n`);
  } catch {
    // ignore
  }
}

function logMarket(marketKey: string, section: string, msg: string): void {
  const line = `[${ts()}] [${section}] [${marketKey}] ${msg}`;
  console.log(line);
  writeToMarketLog(marketKey, "INFO", section, msg);
}

function writeToLogFile(level: string, section: string, msg: string): void {
  if (!LOG_FILE_PATH) return;
  try {
    fs.appendFileSync(LOG_FILE_PATH, `[${ts()}] [${level}] [${section}] ${msg}\n`);
  } catch {
    // ignore write errors
  }
}

function log(section: string, msg: string): void {
  const line = `[${ts()}] [${section}] ${msg}`;
  console.log(line);
  writeToLogFile("INFO", section, msg);
}

function warn(section: string, msg: string): void {
  const line = `[${ts()}] [${section}] ⚠️  ${msg}`;
  console.warn(line);
  writeToLogFile("WARN", section, msg);
}

function err(section: string, msg: string): void {
  const line = `[${ts()}] [${section}] ❌ ${msg}`;
  console.error(line);
  writeToLogFile("ERROR", section, msg);
}

function divider(): void {
  const line = "─".repeat(70);
  console.log(line);
  if (LOG_FILE_PATH) {
    try {
      fs.appendFileSync(LOG_FILE_PATH, `${line}\n`);
    } catch {
      // ignore
    }
  }
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Normalize order ID for reliable comparison (CLOB may return id / orderID / order_id with different casing). */
function normalizeOrderId(id: string): string {
  return String(id).trim().toLowerCase();
}

/** Stable key for same market duration: one buy per outcome per market key. */
function getMarketKey(market: { endDate: string; question?: string; marketId: string }): string {
  return `${market.endDate}|${market.question ?? market.marketId}`;
}

/** Safe filename segment from marketKey for per-market log files. */
function marketKeyToSafeFilename(marketKey: string): string {
  return marketKey.replace(/\|/g, "_").replace(/[/:?*"<>]/g, "_").slice(0, 120);
}

export class PolymarketBot {
  
  private readonly HOST: string;
  private readonly CHAIN_ID: number;
  private readonly GAMMA_HOST: string;
  
  private readonly TARGET_PRICE_UP: number;
  private readonly SELL_PRICE_UP: number;
  private readonly TARGET_PRICE_DOWN: number;
  private readonly SELL_PRICE_DOWN: number;
  private readonly STOP_LOSS_PRICE_UP: number;
  private readonly STOP_LOSS_PRICE_DOWN: number;
  private readonly ORDER_AMOUNT_TOKEN: number;
  private readonly CHECK_INTERVAL: number;
  /** Delay (ms) to wait after a fill before placing SELL so CLOB can credit outcome tokens */
  private readonly SELL_DELAY_MS: number;
  /** Minimum seconds left to enter a market (enter if timeLeftSec >= this; e.g. 20 = even 20s before close) */
  private readonly MIN_SECONDS_TO_ENTER: number;
  /** Skip markets that expire in less than this many seconds (e.g. 180 = 3 min). */
  private readonly MIN_SECONDS_BEFORE_EXPIRY: number;
  /** Seconds before market end to trigger emergency exit (cancel SELL, place aggressive exit). */
  private readonly EXIT_BEFORE_CLOSE_SECONDS: number;
  /** Price for emergency exit SELL when market is about to close. */
  private readonly AGGRESSIVE_EXIT_PRICE: number;
  /** "once" = run one iteration then exit; "continuous" = loop forever. */
  private readonly TRADING_MODE: "once" | "continuous";

  // Runtime state 
  private client: IClobClient | null = null;
  private signer: Wallet | null = null;
  private provider: ethers.providers.JsonRpcProvider | null = null;
  private ClobClientCtor: unknown = null;

  private readonly monitoredMarkets = new Map<string, string>();
  /** marketId -> marketKey for pruning (same duration = same marketKey). */
  private readonly marketIdToMarketKey = new Map<string, string>();
  /** Per market (by marketKey): outcomes we already bought and not yet sold (do not buy same outcome again until sold). */
  private readonly boughtOutcomesPerMarket = new Map<string, Set<"Up" | "Down">>();

  private readonly trackedBuyOrders = new Map<string, TrackedOrder>();
  /** SELL orders we placed (to emergency-exit before market close if still open). */
  private readonly trackedSellOrders = new Map<string, TrackedSellInfo>();
  /** In "once" mode: true after we've entered at least one market; used to exit when that market ends. */
  private onceModeDidEnterMarket = false;

  // constructor
  constructor() {
    this.HOST = config.CLOB_HOST;
    this.CHAIN_ID = parseInt(config.CHAIN_ID, 10);
    this.GAMMA_HOST = config.GAMMA_HOST;
    this.TARGET_PRICE_UP = parseFloat(config.TARGET_PRICE_UP);
    this.SELL_PRICE_UP = parseFloat(config.SELL_PRICE_UP);
    this.TARGET_PRICE_DOWN = parseFloat(config.TARGET_PRICE_DOWN);
    this.SELL_PRICE_DOWN = parseFloat(config.SELL_PRICE_DOWN);
    // Hard stop-loss is fixed at 67% of the buy (target) price
    this.STOP_LOSS_PRICE_UP = this.TARGET_PRICE_UP * 0.67;
    this.STOP_LOSS_PRICE_DOWN = this.TARGET_PRICE_DOWN * 0.67;
    this.ORDER_AMOUNT_TOKEN = parseFloat(config.ORDER_AMOUNT_TOKEN);
    this.CHECK_INTERVAL = parseInt(config.CHECK_INTERVAL, 10);
    this.SELL_DELAY_MS = parseInt(config.SELL_DELAY_MS, 10);
    const minSecEnv = config.MIN_SECONDS_TO_ENTER;
    this.MIN_SECONDS_TO_ENTER =
      minSecEnv !== undefined && minSecEnv !== ""
        ? parseInt(minSecEnv, 10)
        : DEFAULT_MIN_SECONDS_TO_ENTER;
    const minExpiryEnv = config.MIN_SECONDS_BEFORE_EXPIRY;
    this.MIN_SECONDS_BEFORE_EXPIRY =
      minExpiryEnv !== undefined && minExpiryEnv !== ""
        ? parseInt(minExpiryEnv, 10)
        : DEFAULT_MIN_SECONDS_BEFORE_EXPIRY;
    this.EXIT_BEFORE_CLOSE_SECONDS = parseInt(
      config.EXIT_BEFORE_CLOSE_SECONDS ? config.EXIT_BEFORE_CLOSE_SECONDS : String(EXIT_BEFORE_CLOSE_SECONDS),
      10
    );
    this.AGGRESSIVE_EXIT_PRICE = parseFloat(
      config.AGGRESSIVE_EXIT_PRICE ? config.AGGRESSIVE_EXIT_PRICE : String(AGGRESSIVE_EXIT_PRICE)
    );
    const mode = (config.TRADING_MODE ?? "continuous").toLowerCase();
    this.TRADING_MODE = mode === "once" ? "once" : "continuous";

    setLogFile(config.LOG_FILE);

    this.validateConfig();
  }

  // validates all config values
  private validateConfig(): void {
    const in01 = (p: number, name: string) => {
      if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new RangeError(`${name} must be in (0, 1), got ${p}`);
    };
    in01(this.TARGET_PRICE_UP, "TARGET_PRICE_UP");
    in01(this.SELL_PRICE_UP, "SELL_PRICE_UP");
    in01(this.TARGET_PRICE_DOWN, "TARGET_PRICE_DOWN");
    in01(this.SELL_PRICE_DOWN, "SELL_PRICE_DOWN");
    if (this.TARGET_PRICE_UP >= this.SELL_PRICE_UP) {
      throw new RangeError(
        `TARGET_PRICE_UP ($${this.TARGET_PRICE_UP}) must be strictly less than SELL_PRICE_UP ($${this.SELL_PRICE_UP})`
      );
    }
    if (this.TARGET_PRICE_DOWN >= this.SELL_PRICE_DOWN) {
      throw new RangeError(
        `TARGET_PRICE_DOWN ($${this.TARGET_PRICE_DOWN}) must be strictly less than SELL_PRICE_DOWN ($${this.SELL_PRICE_DOWN})`
      );
    }
    if (!Number.isFinite(this.ORDER_AMOUNT_TOKEN) || this.ORDER_AMOUNT_TOKEN < MIN_SHARE_SIZE) {
      throw new RangeError(`ORDER_AMOUNT_TOKEN must be ≥ ${MIN_SHARE_SIZE} (min share size), got ${this.ORDER_AMOUNT_TOKEN}`);
    }
    if (!Number.isInteger(this.CHECK_INTERVAL) || this.CHECK_INTERVAL < 500) {
      throw new RangeError(`CHECK_INTERVAL must be an integer ≥ 500ms, got ${this.CHECK_INTERVAL}`);
    }
    if (!Number.isInteger(this.CHAIN_ID) || this.CHAIN_ID <= 0) {
      throw new RangeError(`CHAIN_ID must be a positive integer, got ${this.CHAIN_ID}`);
    }
    if (!Number.isInteger(this.SELL_DELAY_MS) || this.SELL_DELAY_MS < 0) {
      throw new RangeError(`SELL_DELAY_MS must be a non-negative integer (ms), got ${this.SELL_DELAY_MS}`);
    }
    if (!Number.isInteger(this.MIN_SECONDS_TO_ENTER) || this.MIN_SECONDS_TO_ENTER < 0) {
      throw new RangeError(`MIN_SECONDS_TO_ENTER must be a non-negative integer, got ${this.MIN_SECONDS_TO_ENTER}`);
    }
    if (!Number.isInteger(this.MIN_SECONDS_BEFORE_EXPIRY) || this.MIN_SECONDS_BEFORE_EXPIRY < 0) {
      throw new RangeError(`MIN_SECONDS_BEFORE_EXPIRY must be a non-negative integer, got ${this.MIN_SECONDS_BEFORE_EXPIRY}`);
    }
    if (!Number.isInteger(this.EXIT_BEFORE_CLOSE_SECONDS) || this.EXIT_BEFORE_CLOSE_SECONDS < 0) {
      throw new RangeError(`EXIT_BEFORE_CLOSE_SECONDS must be a non-negative integer, got ${this.EXIT_BEFORE_CLOSE_SECONDS}`);
    }
    if (!Number.isFinite(this.AGGRESSIVE_EXIT_PRICE) || this.AGGRESSIVE_EXIT_PRICE <= 0 || this.AGGRESSIVE_EXIT_PRICE >= 1) {
      throw new RangeError(`AGGRESSIVE_EXIT_PRICE must be in (0, 1), got ${this.AGGRESSIVE_EXIT_PRICE}`);
    }
  }

  
  private usdToShares(usd: number, price: number): number {
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new RangeError(`usdToShares: usd must be a finite positive number, got ${usd}`);
    }
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new RangeError(`usdToShares: price must be in (0, 1), got ${price}`);
    }

    const floored = Math.floor((usd / price) * 100) / 100;

    if (floored < MIN_SHARE_SIZE) {
      warn(
        "ORDER",
        `usdToShares: computed size ${floored} < minimum ${MIN_SHARE_SIZE} share(s) ` +
        `($${usd} / $${price}). Clamping to ${MIN_SHARE_SIZE}.`
      );
      return MIN_SHARE_SIZE;
    }

    return floored;
  }

  private parseJSON<T>(value: unknown, fallback: T): T {
    if (!value) return fallback;
    if (typeof value !== "string") return value as T;
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }


  private parseTokenIds(tokenIds: string | string[]): string[] {
    if (Array.isArray(tokenIds)) return tokenIds;
    return this.parseJSON<string[]>(tokenIds, []);
  }


  private buildMarket(
    eventId: string | null,
    eventName: string | null,
    m: Record<string, unknown>
  ): MarketInfo {
    return {
      eventId,
      eventName,
      marketId: m.id as string,
      question: m.question as string,
      tokenIds: m.clobTokenIds as string | string[],
      outcomes: this.parseJSON<string[]>(m.outcomes, []),
      outcomePrices: this.parseJSON<string[]>(m.outcomePrices, []),
      active: m.active as boolean,
      slug: m.slug as string,
      endDate: m.endDate as string,
      startDate: m.startDate as string,
    };
  }

  async initialize(): Promise<void> {
    divider();
    log("INIT", "Starting initialization...");

    if (!config.PRIVATE_KEY) {
      throw new Error("PRIVATE_KEY environment variable is required");
    }

    log("INIT", "Loading @polymarket/clob-client (ESM)...");
    const clobModule = await import("@polymarket/clob-client");
    this.ClobClientCtor = clobModule.ClobClient;
    log("INIT", "CLOB client module loaded");

    log("INIT", `Connecting to Polygon via ${POLYGON_RPC} ...`);
    this.provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
    this.signer = new Wallet(config.PRIVATE_KEY, this.provider);
    log("INIT", `Wallet address : ${this.signer.address}`);

    const Ctor = this.ClobClientCtor as new (...args: unknown[]) => IClobClient;

    const funderAddress = config.FUNDER_ADDRESS || this.signer!.address;
    log("INIT", `Funder address   : ${funderAddress}`);

    log("INIT", "Creating unauthenticated CLOB client for key derivation...");
    this.client = new Ctor(
      this.HOST,
      this.CHAIN_ID,
      this.signer,
      undefined,        
      2,                
      funderAddress   
    ) as IClobClient;

    await this.deriveAndApplyApiCreds(Ctor);

    await this.logAccountBalance();
    await this.refreshAllowance();

    const approved = await this.approveUSDC();
    if (!approved) {
      warn("INIT", "On-chain USDC approval skipped (no POL for gas) – if you have deposited USDC via Polymarket's web interface, the bot can still trade.");
    }
    divider();
  }

  private async deriveAndApplyApiCreds(
    Ctor: new (...args: unknown[]) => IClobClient
  ): Promise<void> {
    try {
      log("INIT", "Deriving API credentials (nonce=0)...");
      const creds: ApiKeyCreds = await this.client!.deriveApiKey(0);
      log("INIT", `API key derived  : ${creds.key}`);
      log("INIT", `API passphrase   : ${creds.passphrase}`);

      log("INIT", "Re-initializing CLOB client with Gnosis Safe auth...");
      const funderAddress = config.FUNDER_ADDRESS || this.signer!.address;
      this.client = new Ctor(
        this.HOST,
        this.CHAIN_ID,
        this.signer,
        creds,
        2,
        funderAddress
      ) as IClobClient;
      log("INIT", "CLOB client authenticated ✓");
    } catch (e) {
      err("INIT", `API key derivation failed: ${toMessage(e)}`);
      warn("INIT", "Continuing without full auth – order placement will likely fail");
    }
  }

  async approveUSDC(): Promise<boolean> {
    if (!this.signer || !this.provider) throw new Error("Not initialized");

    log("USDC", "Checking USDC approval...");

    const contract = new ethers.Contract(USDC_ADDRESS, [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], this.provider);

    try {
      const allowance: ethers.BigNumber =
        await contract.allowance(this.signer.address, CLOB_EXCHANGE_ADDRESS);
      log("USDC", `Current allowance: ${ethers.utils.formatUnits(allowance, 6)} USDC`);

      if (allowance.gte(ethers.utils.parseUnits(String(MIN_USDC_ALLOWANCE_USD), 6))) {
        log("USDC", "Allowance sufficient – no approval needed ✓");
        return true;
      }

      log("USDC", `Allowance below $${MIN_USDC_ALLOWANCE_USD} – sending approval for ${USDC_APPROVAL_AMOUNT} USDC...`);
      return await this.sendUSDCApproval(contract);
    } catch (e) {
      err("USDC", `Approval check failed: ${toMessage(e)}`);
      warn("USDC", "Bot will continue but order placement may fail without USDC approval.");
      warn("USDC", `Fund wallet ${this.signer.address} with POL on Polygon and restart.`);
      return false;
    }
  }

  private async sendUSDCApproval(contract: ethers.Contract): Promise<boolean> {
    if (!this.signer || !this.provider) throw new Error("Not initialized");

    const polBalance = await this.provider.getBalance(this.signer.address);
    log("USDC", `POL balance: ${ethers.utils.formatEther(polBalance)} POL`);

    if (polBalance.isZero()) {
      warn("USDC", "Wallet has 0 POL – cannot pay gas for USDC approval.");
      warn("USDC", `Send POL to ${this.signer.address} on Polygon to enable trading.`);
      return false;
    }

    const tx = await this.signer.sendTransaction({
      to: USDC_ADDRESS,
      data: contract.interface.encodeFunctionData("approve", [
        CLOB_EXCHANGE_ADDRESS,
        ethers.utils.parseUnits(USDC_APPROVAL_AMOUNT, 6),
      ]),
      chainId: this.CHAIN_ID,
      gasPrice: ethers.utils.parseUnits(String(POLYGON_GAS_PRICE_GWEI), "gwei"),
    });

    log("USDC", `Approval tx sent : ${tx.hash}`);
    log("USDC", "Waiting for confirmation...");
    await tx.wait();
    log("USDC", "USDC approval confirmed ✓");
    return true;
  }

  async logAccountBalance(): Promise<string | null> {
    if (!this.client) return null;
    try {
      const { AssetType } = await import("@polymarket/clob-client");
      const result: BalanceAllowance = await this.client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      const balance = parseFloat(result.balance ?? "0") / 1_000_000;
      const allowance = parseFloat(result.allowance ?? "0") / 1_000_000;
      log("BALANCE", `USDC balance  : $${balance.toFixed(2)}`);
      log("BALANCE", `USDC allowance: $${allowance.toFixed(2)}`);
      return balance.toFixed(2);
    } catch (e) {
      err("BALANCE", `Failed to fetch balance: ${toMessage(e)}`);
      return null;
    }
  }

  async refreshAllowance(): Promise<void> {
    if (!this.client) return;
    try {
      const { AssetType } = await import("@polymarket/clob-client");
      const result: BalanceAllowance = await this.client.updateBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      const allowance = parseFloat(result.allowance ?? "0") / 1_000_000;
      log("BALANCE", `Allowance refreshed → $${allowance.toFixed(2)}`);
    } catch (e) {
      warn("BALANCE", `Allowance refresh failed: ${toMessage(e)}`);
    }
  }

  async findBitcoin5MinuteMarkets(): Promise<MarketInfo[]> {
    log("MARKET", "Searching for BTC 5-minute markets...");
    log("MARKET", `Fetching events by series_id=${BTC_5M_SERIES_ID} from Gamma API...`);

    let response = await axios.get<unknown[]>(`${this.GAMMA_HOST}/events`, {
      params: { series_id: BTC_5M_SERIES_ID, active: true, closed: false, limit: 25 },
    });

    log("MARKET", `Gamma /events returned ${response.data?.length ?? 0} event(s)`);

    const bitcoinMarkets: MarketInfo[] =
      (response.data?.length ?? 0) > 0
        ? this.extractMarketsFromEvents(response.data)
        : await this.fetchMarketsBySlug();

    log("MARKET", `Matched ${bitcoinMarkets.length} BTC Up/Down market(s) total`);

    return this.filterLiveMarkets(bitcoinMarkets);
  }


  private extractMarketsFromEvents(events: unknown[]): MarketInfo[] {
    const result: MarketInfo[] = [];

    for (const e of events) {
      const event = e as Record<string, unknown>;
      const markets = (event.markets as unknown[]) ?? [];
      log("MARKET", `Event "${event.title}" has ${markets.length} market(s)`);

      for (const m of markets) {
        const market = m as Record<string, unknown>;
        if (this.isBtcUpDownMarket(market)) {
          result.push(this.buildMarket(event.id as string, event.title as string, market));
        }
      }
    }
    return result;
  }

  // fetches BTC 5m markets directly from Gamma /markets
  private async fetchMarketsBySlug(): Promise<MarketInfo[]> {
    warn("MARKET", "Series search returned empty – falling back to slug search...");

    const response = await axios.get<unknown[]>(`${this.GAMMA_HOST}/markets`, {
      params: {
        slug: BTC_5M_SLUG,
        active: true,
        closed: false,
        enableOrderBook: true,
        limit: 25,
      },
    });

    log("MARKET", `Gamma /markets (slug) returned ${response.data?.length ?? 0} market(s)`);

    if (!Array.isArray(response.data)) return [];

    return response.data
      .map(m => m as Record<string, unknown>)
      .filter(m => this.isBtcUpDownMarket(m))
      .map(m => this.buildMarket(null, null, m));
  }

  private isBtcUpDownMarket(market: Record<string, unknown>): boolean {
    const q = ((market.question as string) ?? "").toLowerCase();
    return q.includes("bitcoin") && q.includes("up or down");
  }

  private filterLiveMarkets(markets: MarketInfo[]): MarketInfo[] {
    const now = new Date();

    const future = markets
      .filter(m => {
        const start = new Date(m.startDate ?? m.endDate);
        const end = new Date(m.endDate);
        // Always skip markets that have fully ended.
        if (end <= now) {
          log("MARKET", `  Skipping inactive: "${m.question}" (ends ${m.endDate})`);
          return false;
        }
        const secsLeft = (end.getTime() - now.getTime()) / 1000;
        if (secsLeft < this.MIN_SECONDS_BEFORE_EXPIRY) {
          log("MARKET", `  Skipping expiring soon: "${m.question}" (${(secsLeft / 60).toFixed(1)}m left < ${this.MIN_SECONDS_BEFORE_EXPIRY / 60}min minimum)`);
          return false;
        }
        return true;
      })
      // Sort by start time so the very next upcoming market is first.
      .sort((a, b) => new Date(a.startDate ?? a.endDate).getTime() - new Date(b.startDate ?? b.endDate).getTime());

    // Dedupe by market key so same 5m window (different API marketIds) is only traded once.
    const seenKeys = new Set<string>();
    const deduped = future.filter(m => {
      const key = getMarketKey(m);
      if (seenKeys.has(key)) {
        log("MARKET", `  Skipping duplicate duration: "${m.question}" (same key as already in list)`);
        return false;
      }
      seenKeys.add(key);
      return true;
    });
    // Only listen to the *earliest* eligible market duration (single slot), not multiple.
    const liveSlice = deduped.slice(0, 1);

    if (liveSlice.length === 0) {
      warn("MARKET", "No active/eligible BTC 5m markets found right now – will retry");
    } else {
      liveSlice.forEach((m, i) => {
        const minsLeft = ((new Date(m.endDate).getTime() - now.getTime()) / 60_000).toFixed(1);
        log("MARKET", `  [${i + 1}] "${m.question}" – ${minsLeft}m left | ends ${m.endDate}`);
      });
    }

    return liveSlice;
  }

  /** Get current price for token. side "buy" = best ask (price to buy), "sell" = best bid (price we get when selling). */
  async getMarketPrice(tokenId: string, side: "buy" | "sell" = "buy"): Promise<number | null> {
    if (!tokenId) throw new RangeError("getMarketPrice: tokenId must be a non-empty string");

    try {
      log("PRICE", `Fetching ${side.toUpperCase()} price for token ${tokenId.slice(0, 10)}...`);
      const res = await axios.get<{ price: string }>(`${this.HOST}/price`, {
        params: { token_id: tokenId, side },
      });

      const price = parseFloat(res.data.price);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) {
        warn("PRICE", `Received out-of-range price ${price} for token ${tokenId}`);
        return null;
      }

      log("PRICE", `Token ${tokenId.slice(0, 10)}... ${side} → $${price}`);
      return price;
    } catch (e) {
      err("PRICE", `Fetch failed for ${tokenId}: ${toMessage(e)}`);
      return null;
    }
  }

  async getOrderBook(tokenId: string): Promise<unknown> {
    if (!tokenId) throw new RangeError("getOrderBook: tokenId must be a non-empty string");

    try {
      log("BOOK", `Fetching order book for token ${tokenId.slice(0, 10)}...`);
      const res = await axios.get(`${this.HOST}/book`, { params: { token_id: tokenId } });
      return res.data;
    } catch (e) {
      err("BOOK", `Fetch failed for ${tokenId}: ${toMessage(e)}`);
      return null;
    }
  }

  async placeLimitOrder(
    tokenId: string,
    side: "BUY" | "SELL",
    price: number,
    size: number
  ): Promise<OrderResult> {
    if (!this.client) throw new Error("placeLimitOrder: CLOB client is not initialized");
    if (!tokenId) throw new RangeError("placeLimitOrder: tokenId must be a non-empty string");
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new RangeError(`placeLimitOrder: price must be in (0, 1), got ${price}`);
    }
    if (!Number.isFinite(size) || size < MIN_SHARE_SIZE) {
      throw new RangeError(`placeLimitOrder: size must be ≥ ${MIN_SHARE_SIZE}, got ${size}`);
    }

    const costUsd = (price * size).toFixed(4);
    log("ORDER", `Placing ${side} | size=${size} shares | price=$${price} | cost=$${costUsd} USDC`);
    log("ORDER", `  token: ${tokenId}`);

    const { OrderType } = await import("@polymarket/clob-client");

    const orderArgs: OrderArgs = { tokenID: tokenId, price, size, side };
    const options: OrderOptions = { tickSize: 0.01, negRisk: false };

    const res = await this.client.createAndPostOrder(orderArgs, options, OrderType.GTC);

    if (!res?.orderID) {
      throw new Error(
        `CLOB rejected ${side} order for token ${tokenId.slice(0, 10)}… – ` +
        `no orderID in response (check logs above for CLOB error detail)`
      );
    }

    log("ORDER", `✓ ${side} confirmed | orderID: ${res.orderID} | ${size} @ $${price} = $${costUsd}`);
    return res;
  }

  //  place BUY limit orders on Up and/or Down at TARGET_PRICE_UP / TARGET_PRICE_DOWN. Only places for side(s) where placeUp/placeDown is true and not already bought. One BUY per outcome per market until that outcome is sold.
  async placeBothSidedBuys(
    market: MarketInfo,
    options?: { placeUp?: boolean; placeDown?: boolean }
  ): Promise<BothSidedOrders | false> {
    const tokenIds = this.parseTokenIds(market.tokenIds);
    if (tokenIds.length < 2) {
      warn("ORDER", `Market "${market.question}" has fewer than 2 token IDs – skipping`);
      return false;
    }

    const marketKey = getMarketKey(market);
    const placeUp = options?.placeUp !== false;
    const placeDown = options?.placeDown !== false;
    if (!placeUp && !placeDown) {
      log("ORDER", "Neither Up nor Down requested – skipping");
      logMarket(marketKey, "ORDER", "Neither Up nor Down requested – skipping");
      return false;
    }

    const bought = this.boughtOutcomesPerMarket.get(marketKey) ?? new Set<"Up" | "Down">();
    const doUp = placeUp && !bought.has("Up");
    const doDown = placeDown && !bought.has("Down");
    if (!doUp && !doDown) {
      log("ORDER", `Market ${market.marketId} – no new BUYs to place (already bought or not at target for requested sides)`);
      logMarket(marketKey, "ORDER", `No new BUYs (already bought Up/Down or not at target)`);
      return false;
    }

    const sizeUp = this.ORDER_AMOUNT_TOKEN;
    const sizeDown = this.ORDER_AMOUNT_TOKEN;
    const usdUp = sizeUp * this.TARGET_PRICE_UP;
    const usdDown = sizeDown * this.TARGET_PRICE_DOWN;

    log("ORDER", `Up: ${sizeUp} shares @ $${this.TARGET_PRICE_UP}  |  Down: ${sizeDown} shares @ $${this.TARGET_PRICE_DOWN} (placing: Up ${doUp ? "yes" : "no"} Down ${doDown ? "yes" : "no"})`);
    logMarket(marketKey, "ORDER", `Placing: Up ${doUp ? "yes" : "no"} Down ${doDown ? "yes" : "no"} (${sizeUp} @ $${this.TARGET_PRICE_UP} / ${sizeDown} @ $${this.TARGET_PRICE_DOWN})`);

    let upOrder: OrderResult | null = null;
    let downOrder: OrderResult | null = null;

    if (doUp) {
      log("ORDER", `Placing BUY on Up   token: ${tokenIds[0].slice(0, 10)}...`);
      logMarket(marketKey, "ORDER", `BUY Up ${sizeUp} @ $${this.TARGET_PRICE_UP}`);
      upOrder = await this.placeLimitOrder(tokenIds[0], "BUY", this.TARGET_PRICE_UP, sizeUp);
      this.trackBuyOrder(upOrder, tokenIds[0], "Up", market, sizeUp);
      if (!this.boughtOutcomesPerMarket.has(marketKey)) this.boughtOutcomesPerMarket.set(marketKey, new Set());
      this.boughtOutcomesPerMarket.get(marketKey)!.add("Up");
    } else if (placeUp) {
      log("ORDER", `Skipping BUY Up – already bought this outcome in market ${market.marketId}`);
      logMarket(marketKey, "ORDER", `Skipping BUY Up – already bought this outcome`);
    }
    if (doDown) {
      log("ORDER", `Placing BUY on Down token: ${tokenIds[1].slice(0, 10)}...`);
      logMarket(marketKey, "ORDER", `BUY Down ${sizeDown} @ $${this.TARGET_PRICE_DOWN}`);
      downOrder = await this.placeLimitOrder(tokenIds[1], "BUY", this.TARGET_PRICE_DOWN, sizeDown);
      this.trackBuyOrder(downOrder, tokenIds[1], "Down", market, sizeDown);
      if (!this.boughtOutcomesPerMarket.has(marketKey)) this.boughtOutcomesPerMarket.set(marketKey, new Set());
      this.boughtOutcomesPerMarket.get(marketKey)!.add("Down");
    } else if (placeDown) {
      log("ORDER", `Skipping BUY Down – already bought this outcome in market ${market.marketId}`);
      logMarket(marketKey, "ORDER", `Skipping BUY Down – already bought this outcome`);
    }

    if (!upOrder && !downOrder) return false;
    const costUp = upOrder ? this.ORDER_AMOUNT_TOKEN * this.TARGET_PRICE_UP : 0;
    const costDown = downOrder ? this.ORDER_AMOUNT_TOKEN * this.TARGET_PRICE_DOWN : 0;
    log(
      "ORDER",
      `BUYs placed ✓  exposure: $${(costUp + costDown).toFixed(2)} USDC ` +
      `(Up ${sizeUp}×$${this.TARGET_PRICE_UP}=$${usdUp.toFixed(2)} / Down ${sizeDown}×$${this.TARGET_PRICE_DOWN}=$${usdDown.toFixed(2)})`
    );
    logMarket(marketKey, "ORDER", `BUYs placed ✓ exposure $${(costUp + costDown).toFixed(2)} USDC`);
    return {
      upOrder: upOrder ?? (downOrder as OrderResult),
      downOrder: downOrder ?? (upOrder as OrderResult),
    };
  }

  private trackBuyOrder(
    order: OrderResult,
    tokenId: string,
    outcome: "Up" | "Down",
    market: MarketInfo,
    size: number
  ): void {
    if (!order.orderID) {
      warn("ORDER", `Received BUY response without orderID for ${outcome} – cannot track fill`);
      return;
    }
    const marketKey = getMarketKey(market);
    this.trackedBuyOrders.set(order.orderID, {
      tokenId,
      outcome,
      marketId: market.marketId,
      marketKey,
      endDate: market.endDate,
      size,
    });
    log("ORDER", `Tracking BUY (${outcome}) orderId=${order.orderID}`);
    logMarket(marketKey, "ORDER", `Tracking BUY ${outcome} orderId=${order.orderID}`);
  }

  async checkFilledOrders(): Promise<void> {
    if (!this.client || this.trackedBuyOrders.size === 0) {
      log("FILL", `No tracked BUY orders to check (count=${this.trackedBuyOrders.size})`);
      return;
    }

    log("FILL", `Checking ${this.trackedBuyOrders.size} tracked BUY order(s) for fills...`);

    const openIds = await this.fetchOpenOrderIds();
    if (openIds === null) return; // fetch failed – skip this cycle

    log("FILL", `Open order IDs: [${[...openIds].join(", ") || "none"}]`);

    const filled: [string, TrackedOrder][] = [];
    for (const [orderId, info] of this.trackedBuyOrders.entries()) {
      if (openIds.has(normalizeOrderId(orderId))) {
        log("FILL", `  BUY ${orderId} (${info.outcome}) → still open`);
        continue;
      }
      filled.push([orderId, info]);
    }

    for (let i = 0; i < filled.length; i++) {
      const [orderId, info] = filled[i];
      log("FILL", `  BUY ${orderId} (${info.outcome}) → FILLED 🎯`);
      await this.handleFilledBuy(orderId, info);
      if (i < filled.length - 1) {
        const gapMs = 4000;
        log("FILL", `  Waiting ${gapMs}ms before next SELL (settlement)...`);
        await new Promise(resolve => setTimeout(resolve, gapMs));
      }
    }

    log("FILL", filled.length === 0 ? "No fills detected this cycle" : `${filled.length} fill(s) processed`);
  }

  /**
   * When a tracked SELL is no longer open (filled or cancelled), remove it from tracking.
   * We deliberately DO NOT clear boughtOutcomesPerMarket here so that each outcome
   * (Up/Down) is bought at most once per market duration, even if it is later sold.
   */
  private async removeFilledSellOrdersFromTracking(): Promise<void> {
    if (!this.client || this.trackedSellOrders.size === 0) return;

    const openIds = await this.fetchOpenOrderIds();
    if (openIds === null) return;

    for (const [orderId, info] of [...this.trackedSellOrders.entries()]) {
      if (openIds.has(normalizeOrderId(orderId))) continue;
      this.trackedSellOrders.delete(orderId);
      log("FILL", `  SELL ${orderId} (${info.outcome}) filled or cancelled – tracking entry removed`);
      logMarket(info.marketKey, "FILL", `SELL ${info.outcome} filled/cancelled – tracking entry removed`);
    }
  }

  /**
   * Keep listening to prices after BUY: if a tracked BUY is no longer open and market price is at or above
   * our SELL target, treat as filled and place SELL (catches missed fill detection from getOpenOrders).
   */
  private async placeSellWhenPriceReachedIfMissed(): Promise<void> {
    if (!this.client || this.trackedBuyOrders.size === 0) return;

    const openIds = await this.fetchOpenOrderIds();
    if (openIds === null) return;

    for (const [orderId, info] of [...this.trackedBuyOrders.entries()]) {
      if (openIds.has(normalizeOrderId(orderId))) continue; // still open, nothing to do

      const sellPrice = info.outcome === "Up" ? this.SELL_PRICE_UP : this.SELL_PRICE_DOWN;
      const currentPrice = await this.getMarketPrice(info.tokenId, "sell");
      if (currentPrice == null || currentPrice < sellPrice) continue;

      log("FILL", `  Price at/above SELL target ($${currentPrice} >= $${sellPrice}) for ${info.outcome} – treating BUY ${orderId} as filled, placing SELL...`);
      await this.handleFilledBuy(orderId, info);
      break; // one per loop to avoid hammering
    }
  }

  private async fetchOpenOrderIds(): Promise<Set<string> | null> {
    try {
      const openOrders = await this.client!.getOpenOrders();
      log("FILL", `CLOB returned ${openOrders.length} open order(s)`);

      return new Set(
        openOrders
          .map(o => o.id ?? o.orderID ?? o.order_id)
          .filter((id): id is string => typeof id === "string")
          .map(normalizeOrderId)
      );
    } catch (e) {
      err("FILL", `Failed to fetch open orders: ${toMessage(e)}`);
      return null;
    }
  }

  private async handleFilledBuy(orderId: string, info: TrackedOrder): Promise<void> {
    log("FILL", `  BUY ${orderId} (${info.outcome}) filled – waiting ${this.SELL_DELAY_MS}ms for settlement before SELL...`);
    logMarket(info.marketKey, "FILL", `BUY ${orderId} (${info.outcome}) filled – placing SELL after ${this.SELL_DELAY_MS}ms`);
    await new Promise(resolve => setTimeout(resolve, this.SELL_DELAY_MS));

    const targetSellPrice = info.outcome === "Up" ? this.SELL_PRICE_UP : this.SELL_PRICE_DOWN;
    const targetPrice = info.outcome === "Up" ? this.TARGET_PRICE_UP : this.TARGET_PRICE_DOWN;

    // Sell at current bid if it is at least the configured SELL price; otherwise place at SELL price.
    let sellPrice = targetSellPrice;
    const currentBid = await this.getMarketPrice(info.tokenId, "sell");
    if (currentBid != null && currentBid >= targetSellPrice) {
      sellPrice = currentBid;
    }

    log("FILL", `  Placing SELL ${info.size} shares @ $${sellPrice} for ${info.outcome} (target=$${targetSellPrice})...`);

    try {
      const sellOrder = await this.placeLimitOrder(
        info.tokenId,
        "SELL",
        sellPrice,
        info.size
      );
      this.trackedBuyOrders.delete(orderId);
      this.trackedSellOrders.set(sellOrder.orderID, {
        tokenId: info.tokenId,
        outcome: info.outcome,
        marketId: info.marketId,
        marketKey: info.marketKey,
        endDate: info.endDate,
        size: info.size,
      });
      const potentialProfit = ((sellPrice - targetPrice) * info.size).toFixed(4);
      log("FILL", `  SELL placed ✓ orderId=${sellOrder.orderID} | potential profit=$${potentialProfit} USDC`);
      logMarket(info.marketKey, "FILL", `SELL placed ✓ orderId=${sellOrder.orderID} ${info.size} @ $${sellPrice} potential profit=$${potentialProfit}`);
    } catch (e) {
      const msg = toMessage(e);
      const isBalanceError = /not enough balance|allowance/i.test(msg);
      err("FILL", `Failed to place SELL for filled buy ${orderId}: ${msg}`);
      if (isBalanceError) {
        warn("FILL", `Settlement may still be in progress – will retry SELL next loop (keep order in tracking).`);
      } else {
        this.trackedBuyOrders.delete(orderId);
      }
    }
  }

  /** When market is about to close, cancel resting SELL and place aggressive exit so we don't hold into resolution. */
  async emergencyExitNearClose(): Promise<void> {
    if (!this.client || this.trackedSellOrders.size === 0) return;

    const openIds = await this.fetchOpenOrderIds();
    if (openIds === null) return;

    const now = new Date();

    for (const [orderId, info] of [...this.trackedSellOrders.entries()]) {
      if (!openIds.has(normalizeOrderId(orderId))) {
        // SELL already filled or cancelled; just drop from tracking.
        this.trackedSellOrders.delete(orderId);
        continue;
      }
      const secsLeft = (new Date(info.endDate).getTime() - now.getTime()) / 1000;
      if (secsLeft > this.EXIT_BEFORE_CLOSE_SECONDS) continue;

      log("EXIT", `Market closes in ${secsLeft.toFixed(0)}s – emergency exit ${info.outcome} (${info.size} shares) @ $${this.AGGRESSIVE_EXIT_PRICE}`);
      logMarket(info.marketKey, "EXIT", `Emergency exit ${info.outcome} ${info.size} shares @ $${this.AGGRESSIVE_EXIT_PRICE}`);
      this.trackedSellOrders.delete(orderId);
      try {
        await this.client.cancelOrder(orderId);
        log("EXIT", `  Cancelled resting SELL ${orderId}`);
      } catch (e) {
        err("EXIT", `Cancel failed for ${orderId}: ${toMessage(e)}`);
      }
      try {
        await this.placeLimitOrder(info.tokenId, "SELL", this.AGGRESSIVE_EXIT_PRICE, info.size);
        log("EXIT", `  Placed aggressive SELL @ $${this.AGGRESSIVE_EXIT_PRICE} ✓ (avoid holding into resolution)`);
      } catch (e) {
        err("EXIT", `Aggressive SELL failed: ${toMessage(e)}`);
      }
    }
  }

  /**
   * Hard stop-loss: for each open SELL (an open position with a take-profit), if current bid <= configured
   * stop-loss price for that outcome, cancel the existing SELL and place an immediate exit at current bid.
   */
  private async enforceStopLoss(): Promise<void> {
    if (!this.client || this.trackedSellOrders.size === 0) return;

    for (const [orderId, info] of [...this.trackedSellOrders.entries()]) {
      const stopLoss =
        info.outcome === "Up" ? this.STOP_LOSS_PRICE_UP : this.STOP_LOSS_PRICE_DOWN;
      if (stopLoss == null) continue;

      const currentBid = await this.getMarketPrice(info.tokenId, "sell");
      if (currentBid == null) continue;
      if (currentBid > stopLoss) continue;

      log("STOP", `Stop-loss triggered for ${info.outcome}: bid=$${currentBid} <= $${stopLoss} – exiting immediately`);
      logMarket(info.marketKey, "STOP", `Stop-loss hit: bid=$${currentBid} <= $${stopLoss} – cancelling TP ${orderId} and exiting`);

      try {
        await this.client!.cancelOrder(orderId);
        log("STOP", `  Cancelled TP SELL ${orderId}`);
      } catch (e) {
        err("STOP", `Cancel failed for TP SELL ${orderId}: ${toMessage(e)}`);
      }

      try {
        const exitOrder = await this.placeLimitOrder(info.tokenId, "SELL", currentBid, info.size);
        this.trackedSellOrders.delete(orderId);
        this.trackedSellOrders.set(exitOrder.orderID, info);
        log("STOP", `  Placed stop-loss SELL @ $${currentBid} ✓ (orderId=${exitOrder.orderID})`);
        logMarket(info.marketKey, "STOP", `Stop-loss SELL placed @ $${currentBid} orderId=${exitOrder.orderID}`);
      } catch (e) {
        err("STOP", `Stop-loss SELL failed: ${toMessage(e)}`);
      }

      // One stop-loss action per loop to avoid hammering the API.
      break;
    }
  }

  async cancelExpiredMarketOrders(): Promise<void> {
    if (!this.client) return;

    const now = new Date();
    const expired = [...this.trackedBuyOrders.entries()].filter(
      ([, info]) => new Date(info.endDate) <= now
    );

    if (expired.length === 0) {
      log("EXPIRE", "No expired market orders to cancel");
    } else {
      log("EXPIRE", `Found ${expired.length} unfilled BUY(s) in expired markets – cancelling...`);
      await this.cancelOrders(expired);
    }

    this.pruneExpiredMonitoredMarkets(now);
  }

  private async cancelOrders(orders: [string, TrackedOrder][]): Promise<void> {
    for (const [orderId, info] of orders) {
      log("EXPIRE", `  Cancelling BUY ${orderId} (${info.outcome}) – market ended ${info.endDate}`);
      this.trackedBuyOrders.delete(orderId); // remove before cancel to prevent re-cancel
      try {
        await this.client!.cancelOrder(orderId);
        log("EXPIRE", `  Cancelled ✓ ${orderId}`);
      } catch (e) {
        err("EXPIRE", `Cancel failed for ${orderId}: ${toMessage(e)}`);
      }
    }
  }

  private pruneExpiredMonitoredMarkets(now: Date): void {
    let pruned = 0;
    for (const [marketId, endDate] of this.monitoredMarkets.entries()) {
      if (new Date(endDate) <= now) {
        const marketKey = this.marketIdToMarketKey.get(marketId);
        this.monitoredMarkets.delete(marketId);
        this.marketIdToMarketKey.delete(marketId);
        if (marketKey) this.boughtOutcomesPerMarket.delete(marketKey);
        pruned++;
        log("EXPIRE", `  Pruned monitored market ${marketId} (ended ${endDate})`);
        if (marketKey) logMarket(marketKey, "EXPIRE", `Market ended and pruned`);
      }
    }
    for (const [orderId, info] of this.trackedSellOrders.entries()) {
      if (new Date(info.endDate) <= now) this.trackedSellOrders.delete(orderId);
    }
    if (pruned > 0) log("EXPIRE", `${pruned} market(s) removed from monitored set`);
  }

  async enterMarket(market: MarketInfo): Promise<boolean> {
    const tokenIds = this.parseTokenIds(market.tokenIds);
    if (tokenIds.length < 2) {
      warn("ENTER", `Market "${market.question}" has fewer than 2 token IDs – skipping`);
      return false;
    }

    const now = new Date();
    const secsLeft = (new Date(market.endDate).getTime() - now.getTime()) / 1000;
    const minsLeft = secsLeft / 60;

    const marketKey = getMarketKey(market);
    divider();
    log("ENTER", `Market    : ${market.question}`);
    log("ENTER", `Market ID : ${market.marketId}`);
    log("ENTER", `Ends      : ${market.endDate}  (${minsLeft.toFixed(2)}m left)`);
    logMarket(marketKey, "ENTER", `Evaluating market: ${market.question} ends ${market.endDate} (${minsLeft.toFixed(2)}m left)`);
    log("ENTER", `Outcomes  : ${market.outcomes.join(" / ")}`);
    log("ENTER", `Up token  : ${tokenIds[0]}`);
    log("ENTER", `Down token: ${tokenIds[1]}`);

    const [priceUp, priceDown] = await Promise.all([
      this.getMarketPrice(tokenIds[0]),
      this.getMarketPrice(tokenIds[1]),
    ]);
    log(
      "ENTER",
      `Up   price: $${priceUp?.toFixed(4) ?? "n/a"} | BUY target: $${this.TARGET_PRICE_UP} | SELL target: $${this.SELL_PRICE_UP}`
    );
    log(
      "ENTER",
      `Down price: $${priceDown?.toFixed(4) ?? "n/a"} | BUY target: $${this.TARGET_PRICE_DOWN} | SELL target: $${this.SELL_PRICE_DOWN}`
    );

    const upOk = priceUp != null && priceUp <= this.TARGET_PRICE_UP;
    const downOk = priceDown != null && priceDown <= this.TARGET_PRICE_DOWN;
    if (!upOk && !downOk) {
      log(
        "ENTER",
        `Prices not at target – Up ${upOk ? "✓" : "✗"} Down ${downOk ? "✓" : "✗"} (need at least one ≤ target to enter)`
      );
      divider();
      return false;
    }
    log(
      "ENTER",
      `At least one at target – Up ${upOk ? "✓" : "✗"} Down ${downOk ? "✓" : "✗"} (will place BUY only for side(s) at target)`
    );

    if (secsLeft < this.MIN_SECONDS_TO_ENTER) {
      warn(
        "ENTER",
        `Only ${secsLeft.toFixed(0)}s left – skipping (need ≥ ${this.MIN_SECONDS_TO_ENTER}s to enter)`
      );
      divider();
      return false;
    }

    const usdUp = this.ORDER_AMOUNT_TOKEN * this.TARGET_PRICE_UP;
    const usdDown = this.ORDER_AMOUNT_TOKEN * this.TARGET_PRICE_DOWN;
    log("ENTER", `Entering – placing BUY only for side(s) at target (${this.ORDER_AMOUNT_TOKEN} tokens: Up ≈ $${usdUp.toFixed(2)}, Down ≈ $${usdDown.toFixed(2)})...`);

    const orders = await this.placeBothSidedBuys(market, { placeUp: upOk, placeDown: downOk });
    if (!orders) {
      warn("ENTER", "placeBothSidedBuys returned false – market not entered");
      divider();
      return false;
    }

    this.monitoredMarkets.set(market.marketId, market.endDate);
    this.marketIdToMarketKey.set(market.marketId, marketKey);
    if (this.TRADING_MODE === "once") this.onceModeDidEnterMarket = true;
    log("ENTER", `Market entered ✓ | Tracked buys: ${this.trackedBuyOrders.size} | Monitored: ${this.monitoredMarkets.size}`);
    logMarket(marketKey, "ENTER", `Market entered ✓ marketId=${market.marketId} ends=${market.endDate}`);
    divider();
    return true;
  }


  async start(): Promise<void> {
    divider();
    console.log("  🤖  Polymarket BTC 5-Minute Trading Bot");
    divider();
    log("CONFIG", `CLOB host        : ${this.HOST}`);
    log("CONFIG", `Gamma host       : ${this.GAMMA_HOST}`);
    log("CONFIG", `Chain ID         : ${this.CHAIN_ID}  (Polygon)`);
    log("CONFIG", `Up   BUY target: $${this.TARGET_PRICE_UP}  SELL target: $${this.SELL_PRICE_UP}`);
    log("CONFIG", `Down BUY target: $${this.TARGET_PRICE_DOWN}  SELL target: $${this.SELL_PRICE_DOWN}`);
    log("CONFIG", `Stop loss        : Up $${this.STOP_LOSS_PRICE_UP.toFixed(4)} / Down $${this.STOP_LOSS_PRICE_DOWN.toFixed(4)} (67% of target)`);
    log("CONFIG", `Order amount     : ${this.ORDER_AMOUNT_TOKEN} tokens per side (Up ≈ $${(this.ORDER_AMOUNT_TOKEN * this.TARGET_PRICE_UP).toFixed(2)}, Down ≈ $${(this.ORDER_AMOUNT_TOKEN * this.TARGET_PRICE_DOWN).toFixed(2)} USDC)`);
    log("CONFIG", `Check interval   : ${this.CHECK_INTERVAL}ms`);
    log("CONFIG", `SELL delay      : ${this.SELL_DELAY_MS}ms (after fill, before SELL)`);
    log("CONFIG", `Min time to enter: ${this.MIN_SECONDS_TO_ENTER}s left (enter & sell even close to close)`);
    log("CONFIG", `Min before expiry : ${this.MIN_SECONDS_BEFORE_EXPIRY}s (skip markets expiring in < ${this.MIN_SECONDS_BEFORE_EXPIRY / 60}min)`);
    log("CONFIG", `Emergency exit   : when ≤${this.EXIT_BEFORE_CLOSE_SECONDS}s left, sell @ $${this.AGGRESSIVE_EXIT_PRICE} (don't hold into resolution)`);
    log("CONFIG", `Trading mode     : ${this.TRADING_MODE}`);
    if (LOG_FILE_PATH) log("CONFIG", `Log file         : ${LOG_FILE_PATH}`);
    const marketLogsDir = path.isAbsolute(MARKET_LOGS_DIR) ? MARKET_LOGS_DIR : path.resolve(process.cwd(), MARKET_LOGS_DIR);
    log("CONFIG", `Per-market logs  : ${marketLogsDir}/<marketKey>.log`);
    divider();

    await this.initialize();

    log(
      "LOOP",
      this.TRADING_MODE === "once"
        ? "Starting main loop (mode=once: one market duration only, then exit)..."
        : "Starting main loop (mode=continuous)..."
    );

    let iteration = 0;

    const runOneIteration = async (): Promise<void> => {
      iteration++;
      divider();
      log(
        "LOOP",
        `Iteration #${iteration}  |  ` +
        `tracked buys: ${this.trackedBuyOrders.size}  |  ` +
        `monitored markets: ${this.monitoredMarkets.size}`
      );

      try {
        await this.logAccountBalance();
        await this.cancelExpiredMarketOrders();
        if (this.TRADING_MODE === "once" && this.onceModeDidEnterMarket && this.monitoredMarkets.size === 0) {
          log("LOOP", "Once mode: our market ended – exiting.");
          process.exit(0);
        }
        await this.emergencyExitNearClose();
        await this.checkFilledOrders();
        await this.placeSellWhenPriceReachedIfMissed();
        await this.enforceStopLoss();
        await this.removeFilledSellOrdersFromTracking();
        await this.discoverAndEnterMarkets();
      } catch (e) {
        err("LOOP", `Unhandled error in iteration #${iteration}: ${toMessage(e)}`);
      }
    };

    const loop = async (): Promise<void> => {
      await runOneIteration();

      log("LOOP", `Next check in ${this.CHECK_INTERVAL}ms...`);
      setTimeout(loop, this.CHECK_INTERVAL);
    };

    await loop();
  }

  private async discoverAndEnterMarkets(): Promise<void> {
    log("LOOP", "Scanning for new BTC 5m markets...");
    const markets = await this.findBitcoin5MinuteMarkets();

    if (markets.length === 0) {
      warn("LOOP", "No active BTC 5m markets – will retry next interval");
      return;
    }

    const onceModeAndAlreadyInMarket =
      this.TRADING_MODE === "once" && this.monitoredMarkets.size >= 1;

    const monitoredKeys = new Set(this.marketIdToMarketKey.values());
    for (const market of markets) {
      const marketKey = getMarketKey(market);
      if (this.monitoredMarkets.has(market.marketId)) {
        log("LOOP", `Already entered market ${market.marketId} – skipping`);
      } else if (monitoredKeys.has(marketKey)) {
        log("LOOP", `Already in this market duration (${marketKey}) – skipping duplicate`);
      } else if (onceModeAndAlreadyInMarket) {
        log("LOOP", "One-duration mode: already in one market – skipping new markets");
      } else {
        await this.enterMarket(market);
      }
    }
  }


  async getOpenOrders() {
    if (!this.client) return [];
    try {
      log("UTIL", "Fetching open orders...");
      const orders = await this.client.getOpenOrders();
      log("UTIL", `Open orders: ${orders.length}`);
      orders.forEach((o, i) => log("UTIL", `  [${i + 1}] ${JSON.stringify(o)}`));
      return orders;
    } catch (e) {
      err("UTIL", `getOpenOrders failed: ${toMessage(e)}`);
      return [];
    }
  }


  async cancelOrder(orderId: string): Promise<void> {
    if (!this.client) return;
    if (!orderId) throw new RangeError("cancelOrder: orderId must be a non-empty string");

    try {
      log("UTIL", `Cancelling order ${orderId}...`);
      await this.client.cancelOrder(orderId);
      log("UTIL", `Cancelled ✓ ${orderId}`);
    } catch (e) {
      err("UTIL", `Cancel failed for ${orderId}: ${toMessage(e)}`);
    }
  }
}
