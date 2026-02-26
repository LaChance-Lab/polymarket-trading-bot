// ─── Market ───────────────────────────────────────────────────────────────────

export interface MarketInfo {
  eventId: string | null;
  eventName: string | null;
  marketId: string;
  question: string;

  tokenIds: string | string[];
  outcomes: string[];
  outcomePrices: string[];
  active: boolean;
  slug: string;
  endDate: string;
  startDate: string;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export interface OrderResult {
  orderID: string;
  [key: string]: unknown;
}

export interface BothSidedOrders {
  upOrder: OrderResult;
  downOrder: OrderResult;
}

/** Metadata stored for every tracked BUY order */
export interface TrackedOrder {
  tokenId: string;
  outcome: "Up" | "Down";
  marketId: string;
  /** Stable key for same market duration (endDate|question); used for boughtOutcomesPerMarket and per-market log */
  marketKey: string;
  endDate: string;
  size: number;
}

/** Metadata for tracked SELL orders (used to emergency-exit before market close) */
export interface TrackedSellInfo {
  tokenId: string;
  outcome: "Up" | "Down";
  marketId: string;
  marketKey: string;
  endDate: string;
  size: number;
}

// ─── CLOB client – slim interface for the methods we actually use ─────────────

export interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface OpenOrder {
  id?: string;
  orderID?: string;
  order_id?: string;
  [key: string]: unknown;
}

export interface BalanceAllowance {
  balance: string;
  allowance: string;
  asset_type: string;
}

export interface IClobClient {
  deriveApiKey(nonce: number): Promise<ApiKeyCreds>;
  createAndPostOrder(
    orderArgs: OrderArgs,
    options: OrderOptions,
    orderType: unknown
  ): Promise<OrderResult>;
  getOpenOrders(): Promise<OpenOrder[]>;
  cancelOrder(orderId: string): Promise<void>;
  getBalanceAllowance(params: { asset_type: string }): Promise<BalanceAllowance>;
  updateBalanceAllowance(params: { asset_type: string }): Promise<BalanceAllowance>;
}

export interface OrderArgs {
  tokenID: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
}

export interface OrderOptions {
  tickSize: number;
  negRisk: boolean;
}
