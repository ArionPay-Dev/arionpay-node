// Runs against a real ArionPay server. Skipped unless ARIONPAY_IT_BASE_URL is set.
//   ARIONPAY_IT_BASE_URL=http://127.0.0.1:18090 ARIONPAY_IT_API_KEY=pk_... ARIONPAY_IT_API_SECRET=sk_... \
//   ARIONPAY_IT_WEBHOOK_SECRET=whsec_... ARIONPAY_IT_HOOK_PORT=18099 node --test test/
// The store's webhook address must be http://127.0.0.1:<ARIONPAY_IT_HOOK_PORT>/hook (dev server with WEBHOOK_ALLOW_PRIVATE).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ArionPay, ArionPayError, isTestEvent } from "../dist/esm/index.js";

const env = process.env;
const skip = !env.ARIONPAY_IT_BASE_URL && "set ARIONPAY_IT_BASE_URL to run against a real server";

test("full payment through the sandbox, with a real signed webhook", { skip, timeout: 120_000 }, async () => {
  const ap = new ArionPay({ apiKey: env.ARIONPAY_IT_API_KEY, apiSecret: env.ARIONPAY_IT_API_SECRET, webhookSecret: env.ARIONPAY_IT_WEBHOOK_SECRET, baseUrl: env.ARIONPAY_IT_BASE_URL });
  const port = Number(env.ARIONPAY_IT_HOOK_PORT ?? 18099);
  const received = [];
  const waiters = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const ev = ap.verifyWebhook(Buffer.concat(chunks), req.headers["arionpay-signature"]);
        received.push(ev);
        waiters.splice(0).forEach((w) => w());
        res.writeHead(200).end('{"received":true}');
      } catch (e) {
        res.writeHead(401).end(String(e.message));
      }
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const waitFor = async (pred, ms = 60_000) => {
    const end = Date.now() + ms;
    while (!received.some(pred)) {
      if (Date.now() > end) throw new Error(`webhook not received; got ${received.map((e) => e.type).join(", ")}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 1000); });
    }
    return received.find(pred);
  };
  try {
    const currencies = await ap.currencies();
    assert.ok(currencies.some((c) => c.symbol === "USDT_TRC20"));

    const orderId = `it-${Date.now()}`;
    const inv = await ap.createInvoice({ amount: "12.34", currency: "USD", orderId, asset: "USDT_TRC20", test: true, metadata: { cart: 42 }, callbackUrl: `http://127.0.0.1:${port}/hook` });
    assert.match(inv.id, /^[0-9a-f]{24}$/);
    assert.match(inv.invoiceUrl, /\/pay\/[0-9a-f]{24}$/);
    assert.equal(inv.asset, "USDT_TRC20");

    // same idempotency key: same invoice
    const key = `it-key-${Date.now()}`;
    const a = await ap.createInvoice({ amount: "5", orderId: `${orderId}-b`, idempotencyKey: key, test: true });
    const b = await ap.createInvoice({ amount: "5", orderId: `${orderId}-b`, idempotencyKey: key, test: true });
    assert.equal(a.id, b.id);
    await assert.rejects(ap.createInvoice({ amount: "6", orderId: `${orderId}-b`, idempotencyKey: key, test: true }), (e) => e instanceof ArionPayError && e.code === "idempotency_key_reused");

    let read = await ap.getInvoice(inv.id);
    assert.equal(read.status, "new");
    assert.equal(read.test, true);
    assert.deepEqual(read.metadata, { cart: 42 });

    await ap.simulatePayment(inv.id, "exact");
    const paid = await waitFor((e) => e.type === "invoice.paid" && e.data.invoice.id === inv.id);
    assert.equal(paid.data.invoice.status, "paid");
    assert.equal(paid.data.invoice.orderId, orderId);
    assert.equal(paid.data.invoice.test, true);
    assert.equal(paid.livemode, false);
    assert.deepEqual(paid.data.invoice.metadata, { cart: 42 });
    assert.equal(isTestEvent(paid), false, "a sandbox payment is a real event of a test invoice, not a 'Send test webhook' event");

    read = await ap.getInvoice(inv.id);
    assert.equal(read.status, "paid");
    assert.equal(read.amountFiat, 12.34);
    assert.equal(read.asset, "USDT_TRC20");
    assert.ok(read.transactions.length >= 1);

    const t = await ap.sendTestWebhook("invoice.paid");
    assert.equal(t.delivered, true, JSON.stringify(t));
    const testEv = await waitFor((e) => e.id === t.eventId);
    assert.equal(isTestEvent(testEv), true);

    await assert.rejects(ap.getInvoice("0".repeat(24)), (e) => e.status === 404);
    const wrong = new ArionPay({ apiKey: env.ARIONPAY_IT_API_KEY, apiSecret: "sk_wrong", baseUrl: env.ARIONPAY_IT_BASE_URL });
    await assert.rejects(wrong.getInvoice(inv.id), (e) => e.status === 401);
  } finally {
    server.close();
  }
});
