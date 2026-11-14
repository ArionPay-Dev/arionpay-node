/** Any failure talking to the ArionPay API. The message never contains your secret key. */
export class ArionPayError extends Error {
  /** HTTP status, 0 when ArionPay could not be reached. */
  readonly status: number;
  /** Machine-readable code when the API sent one, e.g. "idempotency_key_reused", "rate_limited", "unknown_asset". */
  readonly code: string;
  /** Decoded error body, if any. */
  readonly body: unknown;

  constructor(message: string, status = 0, code = "", body?: unknown) {
    super(message);
    this.name = "ArionPayError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** A webhook that must not be trusted: bad or missing signature, stale timestamp, or a body that is not an event. */
export class ArionPaySignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArionPaySignatureError";
  }
}
