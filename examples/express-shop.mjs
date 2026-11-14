// A minimal shop: "Pay with crypto" button + webhook. Run:
//   npm install express arionpay
//   ARIONPAY_API_KEY=pk_... ARIONPAY_API_SECRET=sk_... ARIONPAY_WEBHOOK_SECRET=whsec_... node express-shop.mjs
// Orders live in memory here; use your database in a real shop.
import express from "express";
import { ArionPay, ArionPaySignatureError, isTestEvent } from "arionpay";

const TEST_MODE = process.env.ARIONPAY_TEST_MODE !== "false"; // test invoices until you set ARIONPAY_TEST_MODE=false
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:3000";
const arionpay = new ArionPay({
  apiKey: process.env.ARIONPAY_API_KEY,
  apiSecret: process.env.ARIONPAY_API_SECRET,
  webhookSecret: process.env.ARIONPAY_WEBHOOK_SECRET,
});

const orders = new Map(); // orderId -> { id, total, currency, status, invoiceId }
const seenEvents = new Set();
const app = express();

app.get("/", (_req, res) => {
  res.send(`<form method="post" action="/checkout"><button>Pay $19.99 with crypto</button></form>`);
});

app.post("/checkout", async (_req, res, next) => {
  try {
    const order = { id: `ord_${Date.now()}`, total: "19.99", currency: "USD", status: "unpaid", invoiceId: null };
    orders.set(order.id, order);
    const invoice = await arionpay.createInvoice({
      amount: order.total,
      currency: order.currency,
      orderId: order.id,
      successUrl: `${PUBLIC_URL}/orders/${order.id}`,
      cancelUrl: `${PUBLIC_URL}/`,
      idempotencyKey: `${order.id}-1`,
      test: TEST_MODE,
      ...(TEST_MODE ? { asset: "USDT_TRC20" } : {}),
    });
    order.invoiceId = invoice.id;
    res.redirect(303, invoice.invoiceUrl);
  } catch (e) {
    next(e);
  }
});

app.get("/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  // Coming back here proves nothing: the status only changes when the webhook arrives.
  res.send(order ? `Order ${order.id}: ${order.status}` : "No such order");
});

app.post("/arionpay/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = arionpay.verifyWebhook(req.body, req.get("ArionPay-Signature"));
  } catch (e) {
    if (e instanceof ArionPaySignatureError) return res.status(401).json({ error: "invalid_signature" });
    throw e;
  }
  if (isTestEvent(event)) return res.json({ received: true, test_event: true });
  if (seenEvents.has(event.id)) return res.json({ received: true, duplicate: true });

  const invoice = event.data.invoice;
  const order = orders.get(invoice.orderId);
  if (!order || order.invoiceId !== invoice.id) return res.json({ received: true, ignored: "unknown_order" });
  if (invoice.test !== TEST_MODE) return res.status(409).json({ error: "test_live_mismatch" });

  switch (event.type) {
    case "invoice.paid":
      if (Number(order.total).toFixed(2) === Number(invoice.amountFiat).toFixed(2) && order.currency === invoice.currency) {
        order.status = "paid"; // deliver the order here
      } else {
        order.status = "check_by_hand";
      }
      break;
    case "invoice.pending":
    case "invoice.partial":
      if (order.status === "unpaid") order.status = "payment_on_its_way";
      break;
    case "invoice.needs_review":
      console.warn(`Order ${order.id} needs a look in the ArionPay dashboard: ${invoice.reviewReason ?? ""}`);
      break;
  }
  seenEvents.add(event.id);
  res.json({ received: true });
});

app.listen(3000, () => console.log(`Shop on ${PUBLIC_URL} (test mode: ${TEST_MODE})`));
