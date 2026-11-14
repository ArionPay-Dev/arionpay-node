import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import {
  ArionPay,
  ArionPayError,
  ArionPaySignatureError,
  isTestEvent,
  isValidWebhookSignature,
  parseSignatureHeader,
  signRequest,
  verifyWebhook,
} from "../dist/esm/index.js";

const SECRET = "whsec_unit_0001";
const hmac = (k, d) => createHmac("sha256", k).update(d).digest("hex");
const event = { id: "evt_abc", type: "invoice.paid", created: 1, livemode: true, data: { invoice: { id: "6af75d7ce83f10cb386f0981", status: "paid" } } };
const signed = (body, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;

test("request signatures match the backend formula", () => {
  assert.equal(signRequest("sk_x", 1700000000, "POST", "/api/v1/invoices", '{"a":1}'), hmac("sk_x", '1700000000.{"a":1}'));
  assert.equal(signRequest("sk_x", 1700000000, "get", "/api/v1/invoices/abc?x=1", "ignored"), hmac("sk_x", "1700000000.GET /api/v1/invoices/abc?x=1"));
});

test("header parsing", () => {
  const v1 = "a".repeat(64);
  assert.deepEqual(parseSignatureHeader(`t=123,v1=${v1}`), { t: 123, v1 });
  assert.deepEqual(parseSignatureHeader(` v1=${v1.toUpperCase()} , t=5 `), { t: 5, v1 });
  for (const bad of ["", null, undefined, "t=1", `v1=${v1}`, `t=x,v1=${v1}`, "t=1,v1=zz", `t=1,v1=${v1}0`]) assert.equal(parseSignatureHeader(bad), null, String(bad));
});

test("valid webhook passes, as string and as Buffer", () => {
  const body = JSON.stringify(event);
  const h = signed(body);
  assert.equal(verifyWebhook(body, h, SECRET).id, "evt_abc");
  assert.equal(verifyWebhook(Buffer.from(body), h, SECRET).type, "invoice.paid");
  assert.equal(isValidWebhookSignature(body, h, SECRET), true);
});

test("non-ASCII body is verified byte for byte", () => {
  const body = JSON.stringify({ ...event, data: { invoice: { ...event.data.invoice, description: "Café ☕ – 東京" } } });
  assert.equal(verifyWebhook(Buffer.from(body, "utf8"), signed(body), SECRET).data.invoice.description, "Café ☕ – 東京");
});

test("tampered, re-serialised, wrong secret, stale and future webhooks fail", () => {
  const body = JSON.stringify(event);
  const h = signed(body);
  assert.throws(() => verifyWebhook(body.replace("paid", "PAID"), h, SECRET), ArionPaySignatureError);
  assert.throws(() => verifyWebhook(JSON.stringify(JSON.parse(body), null, 2), h, SECRET), ArionPaySignatureError);
  assert.throws(() => verifyWebhook(body, h, "whsec_other"), ArionPaySignatureError);
  assert.throws(() => verifyWebhook(body, h, ""), /webhook secret is empty/);
  const old = Math.floor(Date.now() / 1000) - 301;
  assert.throws(() => verifyWebhook(body, signed(body, old), SECRET), /stale/);
  assert.throws(() => verifyWebhook(body, signed(body, old + 602), SECRET), /stale/);
  assert.equal(isValidWebhookSignature(body, signed(body, old), SECRET, { toleranceSec: 600 }), true);
  assert.throws(() => verifyWebhook(JSON.parse(body), h, SECRET), /raw request body/);
  assert.throws(() => verifyWebhook(body, "", SECRET), /Missing or malformed/);
});

test("signed but not an event is refused", () => {
  for (const body of ["not json", "{}", '{"id":"","type":"invoice.paid","data":{"invoice":{}}}', '{"id":"evt_1","type":"invoice.paid"}', '{"id":"evt_1","type":"invoice.paid","data":{"invoice":null}}']) {
    assert.throws(() => verifyWebhook(body, signed(body), SECRET), ArionPaySignatureError, body);
  }
});

test("test events are recognised", () => {
  assert.equal(isTestEvent({ ...event, test: true }), true);
  assert.equal(isTestEvent({ ...event, id: "evt_test_1" }), true);
  assert.equal(isTestEvent({ ...event, data: { invoice: { id: "inv_test_x" } } }), true);
  assert.equal(isTestEvent(event), false);
});

test("constructor checks its options", () => {
  assert.throws(() => new ArionPay({ apiKey: "nope", apiSecret: "s" }), /pk_/);
  assert.throws(() => new ArionPay({ apiKey: "pk_abcdefgh", apiSecret: "" }), /apiSecret/);
  assert.throws(() => new ArionPay({ apiKey: "pk_abcdefgh", apiSecret: "s", baseUrl: "ftp://x" }), /http/);
});

/** A fake fetch that answers from a list and records what it got. */
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init, headers: { ...init.headers } });
    const a = answers.shift();
    if (!a) throw new Error("no more answers");
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: a.headers ?? {} });
  };
  return { fn, calls };
}
const client = (f, extra = {}) => new ArionPay({ apiKey: "pk_unit_000001", apiSecret: "sk_unit", baseUrl: "https://example.test/", fetch: f.fn, ...extra });

test("createInvoice signs the exact body and maps the answer", async () => {
  const f = fakeFetch([{ status: 201, body: { status: "success", id: "a".repeat(24), invoice_url: "https://x/pay/1", data: { id: "a".repeat(24), invoice_url: "https://x/pay/1", amount_fiat: 9.5, currency: "EUR", status: "new", asset: null, address: null, amount_crypto: null, expires_at: "2030-01-01T00:00:00Z", order_id: "7" } } }]);
  const inv = await client(f).createInvoice({ amount: 9.5, currency: "EUR", orderId: "7", description: undefined });
  assert.equal(inv.invoiceUrl, "https://x/pay/1");
  assert.equal(inv.amountFiat, 9.5);
  const c = f.calls[0];
  assert.equal(c.url, "https://example.test/api/v1/invoices");
  const body = JSON.parse(c.body);
  assert.equal(body.amount, "9.5");
  assert.ok(!("description" in body));
  assert.match(body.idempotencyKey, /^sdk_[0-9a-f-]{36}$/);
  assert.equal(c.headers["x-signature"], hmac("sk_unit", `${c.headers["x-timestamp"]}.${c.body}`));
  assert.equal(c.redirect, "error");
});

test("GET is signed over the path, including a base path", async () => {
  const f = fakeFetch([{ body: { invoiceId: "b".repeat(24), status: "PAID", amountFiat: 1, currency: "USD", test: true } }]);
  const inv = await client(f, { baseUrl: "https://example.test/gw/" }).getInvoice("b".repeat(24));
  assert.equal(inv.status, "paid");
  assert.equal(inv.test, true);
  const c = f.calls[0];
  assert.equal(c.url, `https://example.test/gw/api/v1/invoices/${"b".repeat(24)}`);
  assert.equal(c.headers["x-signature"], hmac("sk_unit", `${c.headers["x-timestamp"]}.GET /gw/api/v1/invoices/${"b".repeat(24)}`));
});

test("a replayed signature is signed again once", async () => {
  const f = fakeFetch([{ status: 401, body: { error: "This signed request was already used. Sign each request with a fresh timestamp." } }, { body: { invoiceId: "c".repeat(24), status: "NEW" } }]);
  const inv = await client(f).getInvoice("c".repeat(24));
  assert.equal(inv.status, "new");
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].headers["x-timestamp"], f.calls[1].headers["x-timestamp"]);
});

test("createInvoice retries a network error with the same idempotency key", async () => {
  const f = fakeFetch([new TypeError("fetch failed"), { status: 201, body: { id: "d".repeat(24), invoice_url: "u", data: {} } }]);
  await client(f).createInvoice({ amount: "1" });
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[0].body).idempotencyKey, JSON.parse(f.calls[1].body).idempotencyKey);
});

test("simulate and other non-repeatable calls are not retried; errors carry status and code", async () => {
  const f = fakeFetch([{ status: 503, body: { error: "busy" } }]);
  await assert.rejects(client(f).simulatePayment("e".repeat(24), "exact"), (e) => e instanceof ArionPayError && e.status === 503);
  assert.equal(f.calls.length, 1);
  const g = fakeFetch([{ status: 409, body: { error: "This Idempotency-Key was already used", code: "idempotency_key_reused" } }]);
  await assert.rejects(client(g).createInvoice({ amount: "1", idempotencyKey: "k" }), (e) => e.code === "idempotency_key_reused" && e.status === 409);
  assert.equal(g.calls.length, 1);
});

test("an unreachable server gives status 0 after the allowed attempts", async () => {
  const f = fakeFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
  await assert.rejects(client(f, { maxAttempts: 2 }).getInvoice("f".repeat(24)), (e) => e.status === 0 && /Could not reach/.test(e.message));
  assert.equal(f.calls.length, 2);
});

test("bad ids never reach the network", async () => {
  const f = fakeFetch([]);
  await assert.rejects(client(f).getInvoice("../admin"), TypeError);
  assert.equal(f.calls.length, 0);
});

test("CommonJS build loads", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../dist/cjs/index.js");
  assert.equal(typeof cjs.ArionPay, "function");
  assert.equal(typeof cjs.verifyWebhook, "function");
});
