# ArionPay for Node.js

Official Node.js client for [ArionPay](https://arionpay.com). Create crypto invoices, send customers to the payment page, and check webhooks. The money goes straight to your own wallet: ArionPay never holds it.

- No dependencies. Node.js 18 or newer (also Bun and Deno).
- ESM and CommonJS, with TypeScript types.
- Safe retries: every invoice request carries an idempotency key, so a network error can never create two invoices.

```bash
npm install arionpay
```

## Keys

In your ArionPay dashboard, open your store:

| Value | Where | Starts with |
| --- | --- | --- |
| API key | Store page, **API key** | `pk_` |
| API secret | Store page, **API secret** (asks for your authenticator code) | `sk_` |
| Webhook secret | **Webhooks** page, **signing secret** | `whsec_` |

Keep them on your server, for example in environment variables. Never put the secret key in browser code.

## Take a payment

```js
import { ArionPay } from "arionpay"; // or: const { ArionPay } = require("arionpay");

const arionpay = new ArionPay({
  apiKey: process.env.ARIONPAY_API_KEY,
  apiSecret: process.env.ARIONPAY_API_SECRET,
  webhookSecret: process.env.ARIONPAY_WEBHOOK_SECRET,
});

const invoice = await arionpay.createInvoice({
  amount: "49.90",
  currency: "USD",
  orderId: "1001",
  successUrl: "https://shop.example.com/thanks/1001",
  cancelUrl: "https://shop.example.com/cart",
  metadata: { userId: "u_42" },
});

// send the customer to the ArionPay payment page
res.redirect(invoice.invoiceUrl);
```

The customer coming back to `successUrl` does **not** prove they paid. Deliver the order when the `invoice.paid` webhook arrives (or when `getInvoice` says `paid`).

## Webhooks

Set your webhook address on the **Webhooks** page of the dashboard (a public `https://` address), or per invoice with `callbackUrl`. ArionPay signs every webhook. Check it against the **raw** body, before you parse it.

### Express

```js
import express from "express";
import { ArionPay, ArionPaySignatureError, isTestEvent } from "arionpay";

const app = express();
const arionpay = new ArionPay({ /* keys as above */ });

// express.raw, not express.json: the signature covers the exact bytes
app.post("/arionpay/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = arionpay.verifyWebhook(req.body, req.get("ArionPay-Signature"));
  } catch (e) {
    if (e instanceof ArionPaySignatureError) return res.status(401).send("bad signature");
    throw e;
  }
  if (isTestEvent(event)) return res.json({ received: true }); // "Send test webhook": not a real order

  const invoice = event.data.invoice;
  if (await alreadyProcessed(event.id)) return res.json({ received: true, duplicate: true });

  if (event.type === "invoice.paid") {
    const order = await findOrder(invoice.orderId);
    // Deliver only if the invoice really belongs to this order, for its current total.
    if (order && !order.paid && Number(order.total).toFixed(2) === invoice.amountFiat.toFixed(2) && order.currency === invoice.currency && invoice.test === order.isTest) {
      await markOrderPaid(order, invoice);
    }
  }
  await rememberProcessed(event.id);
  res.json({ received: true });
});
```

### Next.js (App Router)

```js
// app/api/arionpay/webhook/route.js
import { verifyWebhook } from "arionpay";

export async function POST(request) {
  const raw = await request.text();
  try {
    const event = verifyWebhook(raw, request.headers.get("arionpay-signature"), process.env.ARIONPAY_WEBHOOK_SECRET);
    // ... same handling as above
    return Response.json({ received: true });
  } catch {
    return new Response("bad signature", { status: 401 });
  }
}
```

### Events

| Event | Meaning | What to do |
| --- | --- | --- |
| `invoice.pending` | A payment was seen on the network and waits for confirmations. | Show "payment on its way". Do not deliver yet. |
| `invoice.partial` | Less than the full amount arrived. The invoice stays open for the rest. | Do not deliver. |
| `invoice.paid` | Fully paid and confirmed. Also sent when you accept a payment by hand in the dashboard. | Deliver the order. |
| `invoice.expired` | Time ran out without full payment. A late payment can still make it `paid`. | Keep the order unpaid. |
| `invoice.needs_review` | Something needs a person: for example more money arrived after the invoice was paid. | Tell a human. Do not change the order. |

ArionPay sends again if your server does not answer `2xx` (for about 3 days), so the same event can arrive more than once. Use `event.id` to handle each one once.

### Rules for a safe integration

1. Check the signature on the raw body (`verifyWebhook`). Never trust a webhook you could not verify.
2. Deliver only on `invoice.paid` (or `getInvoice(...).status === "paid"`).
3. Match the invoice to your order: your `orderId` or `metadata`, and the same amount and currency as the order's current total.
4. Ignore test events (`isTestEvent(event)`), and in your live shop ignore invoices with `test: true`.
5. Handle each `event.id` once, and answer `2xx` quickly.
6. Do not compare crypto amounts yourself. ArionPay decides when an invoice is paid, including payments inside your store's payment tolerance and payments you accept in Payment Radar.

## Test without real money

```js
const invoice = await arionpay.createInvoice({ amount: "10", orderId: "test-1", asset: "USDT_TRC20", test: true });
await arionpay.simulatePayment(invoice.id, "exact"); // your webhook gets invoice.paid, like a real payment
```

Scenarios: `exact`, `detected`, `confirm`, `underpaid_1pct`, `underpaid_5pct`, `overpaid`, `partial_half`, `late`. Test invoices carry `test: true` in every webhook and read.

`await arionpay.sendTestWebhook("invoice.paid")` sends a signed sample event to your store's webhook address. It describes a made-up invoice (`inv_test_...`) and must never change an order.

## No webhooks? Ask instead

```js
const invoice = await arionpay.getInvoice("6af75d7ce83f10cb386f0981");
if (invoice.status === "paid") { /* deliver */ }
```

`getInvoice` returns the same field names as the webhook's `data.invoice`, so one function can handle both.

## Reference

| Method | Returns |
| --- | --- |
| `createInvoice(params)` | `{ id, invoiceUrl, status, amountFiat, currency, asset, address, amountCrypto, expiresAt, orderId }` |
| `getInvoice(id)` | The invoice (`status`, `amountFiat`, `currency`, `asset`, `paidCrypto`, `transactions`, `test`, `metadata`, ...) |
| `simulatePayment(id, scenario)` | Sandbox only (test invoices). |
| `sendTestWebhook(type?)` | `{ delivered, httpStatus, eventId }` |
| `currencies()` | Coins you can pass as `asset` / `allowedAssets`, e.g. `USDT_TRC20`, `BTC`, `LTC`. |
| `rates(currency?)` | Current coin prices in a fiat currency. |
| `verifyWebhook(rawBody, header)` | The event, or throws `ArionPaySignatureError`. Also exported as a function taking the secret as third argument. |

`createInvoice` parameters: `amount` (required), `currency` (default `USD`), `orderId`, `description`, `customerEmail`, `successUrl`, `cancelUrl`, `callbackUrl`, `asset`, `allowedAssets`, `expiresMin` (5 to 1440), `metadata`, `idempotencyKey`, `test`.

Errors are `ArionPayError` with `status` (HTTP status, `0` when ArionPay could not be reached), `code` (for example `idempotency_key_reused`, `rate_limited`, `unknown_asset`) and `message`. Messages never contain your secret.

Options: `apiKey`, `apiSecret`, `webhookSecret`, `baseUrl` (default `https://merchant.arionpay.com`), `timeoutMs` (default 20000), `maxAttempts` (default 3), `fetch`, `appInfo`.

## License

MIT
