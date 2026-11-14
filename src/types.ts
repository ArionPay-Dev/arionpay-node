/** Invoice status as ArionPay reports it (lower case). */
export type InvoiceStatus =
  | "new" // created, waiting for the customer to choose a coin or pay
  | "pending" // a payment was seen on the network and is waiting for confirmations
  | "paid_partial" // less than the full amount arrived; the invoice stays open for the rest
  | "paid" // fully paid and confirmed: the only status that means "deliver the order"
  | "expired" // timed out without full payment (a late payment can still turn it into "paid")
  | "cancelled"
  | "claim_pending" // the customer said "I already paid"; the merchant checks it in the dashboard
  | "rejected" // the merchant rejected that claim
  | (string & {});

export type WebhookEventType = "invoice.pending" | "invoice.partial" | "invoice.paid" | "invoice.expired" | "invoice.needs_review";

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = ["invoice.pending", "invoice.partial", "invoice.paid", "invoice.expired", "invoice.needs_review"];

/** Sandbox scenarios for {@link ArionPay.simulatePayment} (test invoices only). */
export type SimulationScenario = "detected" | "confirm" | "exact" | "underpaid_1pct" | "underpaid_5pct" | "overpaid" | "partial_half" | "late";

export interface CreateInvoiceParams {
  /** Price in the fiat currency, e.g. "49.90". A string avoids rounding surprises. */
  amount: string | number;
  /** Fiat currency code, e.g. "USD" or "EUR". Default "USD". */
  currency?: string;
  /** Your own order number. It is shown to the customer and sent back in every webhook. */
  orderId?: string;
  description?: string;
  customerEmail?: string;
  /** Where the customer goes after paying. Coming back here does NOT prove payment: wait for the webhook. */
  successUrl?: string;
  /** Where the customer goes if they leave the payment page. */
  cancelUrl?: string;
  /** Webhook address for this invoice only. Without it, the store's webhook address is used. */
  callbackUrl?: string;
  /** Pre-select one coin, e.g. "USDT_TRC20" (codes from {@link ArionPay.currencies}). */
  asset?: string;
  /** Offer only these coins. */
  allowedAssets?: string[];
  /** Minutes until the invoice expires (5 to 1440). */
  expiresMin?: number;
  /** Your own data (e.g. your internal order id). Sent back in webhooks and invoice reads. */
  metadata?: Record<string, unknown>;
  /**
   * The same key always returns the same invoice, so a retry can never create two. The SDK makes a random one for
   * each call when you leave it out; pass your own (e.g. "order-1001-attempt-1") to be safe across process restarts.
   */
  idempotencyKey?: string;
  /** Test invoice: no real money, can be driven with {@link ArionPay.simulatePayment}. */
  test?: boolean;
}

/** What {@link ArionPay.createInvoice} returns. Send the customer to `invoiceUrl`. */
export interface CreatedInvoice {
  id: string;
  invoiceUrl: string;
  status: InvoiceStatus;
  amountFiat: number;
  currency: string;
  /** Set when a coin was pre-selected. */
  asset: string | null;
  address: string | null;
  amountCrypto: string | null;
  expiresAt: string;
  orderId: string | null;
  raw: Record<string, unknown>;
}

export interface InvoiceTransaction {
  txid: string;
  amount: string;
  confirmations: number;
  explorerUrl?: string | null;
  [key: string]: unknown;
}

/**
 * An invoice in the webhook format. {@link ArionPay.getInvoice} returns the same field names, so one function can
 * handle both a webhook and a read.
 */
export interface Invoice {
  id: string;
  status: InvoiceStatus;
  orderId: string | null;
  amountFiat: number;
  currency: string;
  /** Coin code, e.g. "USDT_TRC20". Empty until the customer chose a coin. */
  asset: string;
  network: string;
  amountCrypto: string;
  paidCrypto: string;
  confirmedCrypto: string;
  overpaid: boolean;
  /** Paid a little less, inside the store's payment tolerance, and ArionPay accepted it. */
  underpaidWithinTolerance: boolean;
  /** Paid after the invoice expired. */
  late: boolean;
  needsReview: boolean;
  reviewReason?: string;
  /** The merchant accepted the payment by hand in the dashboard (Payment Radar, mark paid, verified claim). */
  manual: boolean;
  /** Test invoice: no real money moved. Never deliver a real order for it. */
  test: boolean;
  transactions: InvoiceTransaction[];
  metadata: Record<string, unknown>;
  customerEmail?: string;
  address?: string;
  storeId?: string;
  createdAt?: string;
  expiresAt?: string;
  paidAt?: string | null;
  [key: string]: unknown;
}

export interface WebhookEvent {
  /** Unique event id (evt_...). Store it to ignore repeated deliveries. */
  id: string;
  type: WebhookEventType | (string & {});
  /** Unix seconds. */
  created: number;
  livemode: boolean;
  /** True for "Send test webhook" events: a made-up invoice, never a real order. */
  test?: boolean;
  data: { invoice: Invoice };
}

export interface Currency {
  /** Code to use in `asset` / `allowedAssets`, e.g. "USDT_TRC20". */
  symbol: string;
  ticker: string;
  network: string;
  chain: string;
  name: string;
  decimals: number;
  rateUsd: number | null;
  confirmations: number;
}

export interface TestWebhookResult {
  delivered: boolean;
  httpStatus?: number;
  responseTimeMs?: number;
  eventId?: string;
  error?: string;
  [key: string]: unknown;
}
