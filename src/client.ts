import { randomUUID } from "node:crypto";
import { ArionPayError } from "./errors.js";
import { signRequest, verifyWebhook, type VerifyOptions } from "./signature.js";
import type {
  CreateInvoiceParams,
  CreatedInvoice,
  Currency,
  Invoice,
  SimulationScenario,
  TestWebhookResult,
  WebhookEvent,
  WebhookEventType,
} from "./types.js";

export const VERSION = "1.0.1";
export const DEFAULT_BASE_URL = "https://merchant.arionpay.com";

export interface ArionPayOptions {
  /** Store API key from the ArionPay dashboard (starts with pk_). */
  apiKey: string;
  /** Store API secret (starts with sk_). Keep it on your server only. */
  apiSecret: string;
  /** Webhook signing secret (starts with whsec_). Only needed for {@link ArionPay.verifyWebhook}. */
  webhookSecret?: string;
  /** Default https://merchant.arionpay.com. */
  baseUrl?: string;
  /** Per request, default 20000. */
  timeoutMs?: number;
  /** How many times a request that is safe to repeat is tried in all (default 3). */
  maxAttempts?: number;
  /** Your own fetch (tests, proxies). Default: the global fetch of Node 18+. */
  fetch?: typeof fetch;
  /** Added to the User-Agent, e.g. "my-shop/2.1". */
  appInfo?: string;
}

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : v === null || v === undefined ? d : String(v));
const bool = (v: unknown): boolean => v === true;

/**
 * Client for the ArionPay merchant API. Use it on your server only: it holds your secret key.
 *
 * ```ts
 * const arionpay = new ArionPay({ apiKey: process.env.ARIONPAY_API_KEY!, apiSecret: process.env.ARIONPAY_API_SECRET! });
 * const invoice = await arionpay.createInvoice({ amount: "49.90", currency: "USD", orderId: "1001" });
 * // send the customer to invoice.invoiceUrl
 * ```
 */
export class ArionPay {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: URL;
  /** Path part of baseUrl without a trailing slash ("" for none). */
  private readonly basePath: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: ArionPayOptions) {
    if (!opts || !/^pk_[A-Za-z0-9_-]{8,64}$/.test(opts.apiKey ?? "")) throw new TypeError("apiKey must be your store API key (it starts with pk_).");
    if (!opts.apiSecret) throw new TypeError("apiSecret is required (your store API secret, it starts with sk_).");
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.webhookSecret = opts.webhookSecret ?? "";
    const base = new URL(opts.baseUrl ?? DEFAULT_BASE_URL);
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new TypeError("baseUrl must be an http(s) address.");
    base.search = "";
    base.hash = "";
    this.basePath = base.pathname.replace(/\/+$/, "");
    this.baseUrl = base;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxAttempts = Math.max(1, Math.min(5, opts.maxAttempts ?? 3));
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new TypeError("No fetch available: use Node.js 18 or newer, or pass options.fetch.");
    this.fetchFn = f;
    this.userAgent = `arionpay-node/${VERSION} node/${typeof process !== "undefined" ? process.versions?.node ?? "?" : "?"}${opts.appInfo ? ` ${opts.appInfo}` : ""}`;
  }

  /**
   * Create an invoice and get the payment page address. Safe to retry: every call carries an idempotency key, so a
   * repeat after a network error returns the same invoice instead of a second one.
   */
  async createInvoice(params: CreateInvoiceParams): Promise<CreatedInvoice> {
    if (!params || (typeof params.amount !== "string" && typeof params.amount !== "number")) throw new TypeError("amount is required.");
    const body: Json = { ...params, amount: String(params.amount), idempotencyKey: params.idempotencyKey ?? `sdk_${randomUUID()}` };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    const r = await this.request("POST", "/api/v1/invoices", body, true);
    const d = (r.data && typeof r.data === "object" ? r.data : r) as Json;
    return {
      id: str(d.id ?? r.id),
      invoiceUrl: str(d.invoice_url ?? r.invoice_url),
      status: str(d.status, "new"),
      amountFiat: Number(d.amount_fiat ?? params.amount),
      currency: str(d.currency, params.currency ?? "USD"),
      asset: (d.asset as string | null) ?? null,
      address: (d.address as string | null) ?? null,
      amountCrypto: (d.amount_crypto as string | null) ?? null,
      expiresAt: str(d.expires_at),
      orderId: (d.order_id as string | null) ?? params.orderId ?? null,
      raw: r,
    };
  }

  /**
   * Read an invoice, signed, straight from ArionPay. Returns the webhook field names, so the same code can handle a
   * webhook and a read. Use it to double-check a payment, or instead of webhooks (polling).
   */
  async getInvoice(id: string): Promise<Invoice> {
    if (!/^[0-9a-fA-F]{24}$/.test(String(id ?? ""))) throw new TypeError("Invoice id must be the 24-character id ArionPay returned.");
    const r = await this.request("GET", `/api/v1/invoices/${encodeURIComponent(id)}`, undefined, true);
    return normalizeInvoiceRead(r);
  }

  /**
   * Sandbox: move a TEST invoice through a payment scenario, then let webhooks fire as for a real payment.
   * The customer (or this call's `asset`) must have chosen a coin first: create the test invoice with `asset`.
   */
  async simulatePayment(id: string, scenario: SimulationScenario): Promise<Json> {
    if (!/^[0-9a-fA-F]{24}$/.test(String(id ?? ""))) throw new TypeError("Invoice id must be the 24-character id ArionPay returned.");
    return this.request("POST", `/api/v1/invoices/${encodeURIComponent(id)}/simulate`, { scenario }, false);
  }

  /** Ask ArionPay to send a signed test event to your store's webhook address now. It never describes a real order. */
  async sendTestWebhook(eventType: WebhookEventType = "invoice.paid"): Promise<TestWebhookResult> {
    return (await this.request("POST", "/api/v1/webhooks/test", { eventType }, false)) as TestWebhookResult;
  }

  /** Coins and networks ArionPay accepts right now, with USD rates. */
  async currencies(): Promise<Currency[]> {
    const r = await this.request("GET", "/api/v1/currencies", undefined, true, false);
    return Array.isArray(r.currencies) ? (r.currencies as Currency[]) : [];
  }

  /** Current coin prices in one fiat currency, e.g. rates("EUR"). */
  async rates(currency = "USD"): Promise<Record<string, number>> {
    return (await this.request("GET", `/api/v1/rates?currency=${encodeURIComponent(currency)}`, undefined, true, false)) as Record<string, number>;
  }

  /** Check a webhook with the webhookSecret given to the constructor. See {@link verifyWebhook}. */
  verifyWebhook(rawBody: string | Buffer, signatureHeader: string | null | undefined, opts?: VerifyOptions): WebhookEvent {
    return verifyWebhook(rawBody, signatureHeader, this.webhookSecret, opts);
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async request(method: "GET" | "POST", path: string, body: Json | undefined, retrySafe: boolean, signed = true): Promise<Json> {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    let usedReplayRetry = false;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.send(method, path, raw, signed);
      } catch (e) {
        const err = e as ArionPayError;
        // Two identical signed requests in the same second have the same signature; only the first is accepted.
        if (err.status === 401 && /already used/i.test(err.message) && !usedReplayRetry) {
          usedReplayRetry = true;
          await sleep(1100);
          continue;
        }
        const retryAfter = Number((err.body as Json | undefined)?.retryAfterSec ?? 0);
        const temporary = err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504 || (err.status === 429 && retryAfter <= 5);
        if (!retrySafe || !temporary || attempt >= this.maxAttempts) throw err;
        await sleep(err.status === 429 ? Math.max(1, retryAfter) * 1000 : 500 * 3 ** (attempt - 1));
      }
    }
  }

  private async send(method: string, path: string, raw: string | undefined, signed: boolean): Promise<Json> {
    const url = new URL(this.baseUrl.toString());
    const q = path.indexOf("?");
    url.pathname = this.basePath + (q >= 0 ? path.slice(0, q) : path);
    url.search = q >= 0 ? path.slice(q) : "";
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": this.userAgent };
    if (signed) {
      const ts = Math.floor(Date.now() / 1000);
      headers["x-api-key"] = this.apiKey;
      headers["x-timestamp"] = String(ts);
      headers["x-signature"] = signRequest(this.apiSecret, ts, method, url.pathname + url.search, raw ?? "");
    }
    if (raw !== undefined) headers["Content-Type"] = "application/json";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), { method, headers, body: raw, signal: ctrl.signal, redirect: "error" });
    } catch (e) {
      const msg = (e as Error)?.name === "AbortError" ? `no answer within ${this.timeoutMs} ms` : String((e as Error)?.message ?? e);
      throw new ArionPayError(`Could not reach ArionPay: ${msg}`, 0, "network_error");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let decoded: unknown = {};
    try {
      decoded = text ? JSON.parse(text) : {};
    } catch {
      decoded = {};
    }
    const obj = (decoded && typeof decoded === "object" ? decoded : {}) as Json;
    if (res.status < 200 || res.status >= 300) {
      const message = typeof obj.error === "string" ? obj.error : typeof obj.message === "string" ? obj.message : `HTTP ${res.status}`;
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      throw new ArionPayError(`ArionPay API error (${res.status}): ${message}`, res.status, typeof obj.code === "string" ? obj.code : "", {
        ...obj,
        ...(retryAfter ? { retryAfterSec: retryAfter } : {}),
      });
    }
    return obj;
  }
}

/** Turn the signed read (GET /api/v1/invoices/:id) into the webhook invoice field names. */
export function normalizeInvoiceRead(r: Json): Invoice {
  const txs = Array.isArray(r.transactions) ? (r.transactions as Invoice["transactions"]) : [];
  return {
    id: str(r.invoiceId ?? r.id),
    status: str(r.status).toLowerCase(),
    orderId: (r.orderId as string | null) ?? null,
    amountFiat: Number(r.amountFiat ?? 0),
    currency: str(r.currency),
    asset: str(r.settledCurrency),
    network: str(r.network),
    amountCrypto: str(r.amountExpected),
    paidCrypto: str(r.amountReceived, "0"),
    confirmedCrypto: str(r.amountConfirmed, "0"),
    overpaid: bool(r.overpaid),
    underpaidWithinTolerance: bool(r.underpaidWithinTolerance),
    late: bool(r.late),
    needsReview: bool(r.needsReview),
    manual: bool(r.manual),
    test: bool(r.test),
    transactions: txs,
    metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>,
    paidAt: (r.settledAt as string | null) ?? null,
    txHash: r.txHash ?? null,
    confirmations: r.confirmations ?? 0,
    requiredConfirmations: r.requiredConfirmations ?? 0,
    ...(r.paidVia !== undefined ? { paidVia: r.paidVia } : {}),
    raw: r,
  };
}
