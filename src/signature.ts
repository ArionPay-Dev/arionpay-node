import { createHmac, timingSafeEqual } from "node:crypto";
import { ArionPaySignatureError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

/** Webhooks signed more than this many seconds ago (or ahead) are refused. ArionPay signs again on every retry. */
export const DEFAULT_TOLERANCE_SEC = 300;

const hmacHex = (secret: string, data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");

/**
 * Signature of a request to the merchant API.
 *   POST: hex HMAC-SHA256(secret key, "<timestamp>.<raw body>")
 *   GET:  hex HMAC-SHA256(secret key, "<timestamp>.GET <path and query>")
 */
export function signRequest(secretKey: string, timestamp: number, method: string, pathAndQuery: string, rawBody: string): string {
  return method.toUpperCase() === "GET" ? hmacHex(secretKey, `${timestamp}.GET ${pathAndQuery}`) : hmacHex(secretKey, `${timestamp}.${rawBody}`);
}

/** Read an `ArionPay-Signature` header (`t=<unix seconds>,v1=<hex>`). Returns null when it is malformed. */
export function parseSignatureHeader(header: string | null | undefined): { t: number; v1: string } | null {
  const values: Record<string, string> = {};
  for (const part of String(header ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) values[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const t = values.t;
  const v1 = values.v1;
  if (!t || !/^\d{1,12}$/.test(t) || !v1 || !/^[0-9a-fA-F]{64}$/.test(v1)) return null;
  return { t: Number(t), v1: v1.toLowerCase() };
}

export interface VerifyOptions {
  /** Allowed clock difference in seconds (default 300). */
  toleranceSec?: number;
  /** Current time in Unix seconds (for tests). */
  now?: number;
}

/** True when the header is a valid, fresh signature of exactly this body. Never throws. */
export function isValidWebhookSignature(rawBody: string | Buffer, header: string | null | undefined, webhookSecret: string, opts: VerifyOptions = {}): boolean {
  if (!webhookSecret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.t) > (opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC)) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = Buffer.from(hmacHex(webhookSecret, Buffer.concat([Buffer.from(`${parsed.t}.`, "utf8"), body])), "hex");
  const given = Buffer.from(parsed.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Check a webhook and return the event. Throws {@link ArionPaySignatureError} when it must not be trusted.
 *
 * `rawBody` must be the exact bytes ArionPay sent (for Express: `express.raw({ type: "application/json" })`),
 * not a parsed and re-serialised object.
 */
export function verifyWebhook(rawBody: string | Buffer, header: string | null | undefined, webhookSecret: string, opts: VerifyOptions = {}): WebhookEvent {
  if (!webhookSecret) throw new ArionPaySignatureError("The webhook secret is empty. Copy it from the Webhooks page of your ArionPay dashboard (it starts with whsec_).");
  if (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody)) {
    throw new ArionPaySignatureError("rawBody must be the raw request body (string or Buffer), not a parsed object.");
  }
  if (!parseSignatureHeader(header)) throw new ArionPaySignatureError("Missing or malformed ArionPay-Signature header.");
  if (!isValidWebhookSignature(rawBody, header, webhookSecret, opts)) {
    throw new ArionPaySignatureError("Invalid webhook signature or stale timestamp. Check the webhook secret and your server clock.");
  }
  let event: unknown;
  try {
    event = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  } catch {
    throw new ArionPaySignatureError("The webhook body is not JSON.");
  }
  const e = event as Partial<WebhookEvent> | null;
  if (!e || typeof e.id !== "string" || !e.id || typeof e.type !== "string" || !e.data || typeof e.data.invoice !== "object" || e.data.invoice === null) {
    throw new ArionPaySignatureError("The webhook body is not an ArionPay event.");
  }
  return e as WebhookEvent;
}

/** True for events made by "Send test webhook": they describe a made-up invoice and must never change an order. */
export function isTestEvent(event: WebhookEvent): boolean {
  return Boolean(event.test) || event.id.startsWith("evt_test_") || String(event.data?.invoice?.id ?? "").startsWith("inv_test_");
}
