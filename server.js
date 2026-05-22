const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const Stripe = require('stripe');

const app = express();
const port = process.env.PORT || 3000;
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const ORDERS_FILE = path.join(__dirname, 'orders.json');

if (!stripeSecret) {
  console.error('Missing STRIPE_SECRET_KEY environment variable. Please set it before starting the server.');
  process.exit(1);
}

const stripe = Stripe(stripeSecret);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

async function ensureOrdersFile() {
  try {
    await fs.access(ORDERS_FILE);
  } catch {
    await fs.writeFile(ORDERS_FILE, '[]', 'utf8');
  }
}

async function readOrders() {
  const raw = await fs.readFile(ORDERS_FILE, 'utf8');
  return JSON.parse(raw || '[]');
}

async function writeOrders(orders) {
  await fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { items, customer } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'لا يوجد منتجات في الحقيبة للدفع.' });
    }

    const amount = items.reduce((sum, item) => sum + ((item.price || 0) * (item.qty || 1)), 0);
    const orderId = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'egp',
      payment_method_types: ['card'],
      metadata: {
        order_id: orderId,
        customer_name: customer?.name || '',
        customer_phone: customer?.phone || '',
        customer_address: customer?.address || ''
      }
    });

    const order = {
      orderId,
      createdAt: new Date().toISOString(),
      status: 'pending',
      total: amount,
      items,
      customer: {
        name: customer?.name || '',
        address: customer?.address || '',
        phone: customer?.phone || ''
      },
      stripePaymentIntentId: paymentIntent.id
    };

    const orders = await readOrders();
    orders.push(order);
    await writeOrders(orders);

    res.json({ clientSecret: paymentIntent.client_secret, orderId });
  } catch (error) {
    console.error('Payment Intent error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء جلسة الدفع.' });
  }
});

app.post('/confirm-order', async (req, res) => {
  try {
    const { orderId, paymentIntentId } = req.body;
    const orders = await readOrders();
    const order = orders.find((item) => item.orderId === orderId);
    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }

    order.status = 'paid';
    order.stripePaymentIntentId = paymentIntentId || order.stripePaymentIntentId;
    await writeOrders(orders);

    res.json({ success: true });
  } catch (error) {
    console.error('Confirm order error:', error);
    res.status(500).json({ error: 'تعذر تأكيد الطلب.' });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customer } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'لا يوجد منتجات في الحقيبة للدفع.' });
    }

    const line_items = items.map((item) => ({
      price_data: {
        currency: 'egp',
        product_data: {
          name: item.name || 'منتج',
          description: item.desc || 'شراء عبر متجر Handmade'
        },
        unit_amount: Math.round((item.price || 0) * 100)
      },
      quantity: item.qty || 1
    }));

    const total = items.reduce((sum, item) => sum + ((item.price || 0) * (item.qty || 1)), 0);
    const orderId = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const order = {
      orderId,
      createdAt: new Date().toISOString(),
      status: 'pending',
      total,
      items,
      customer: {
        name: customer?.name || '',
        address: customer?.address || '',
        phone: customer?.phone || ''
      }
    };

    const origin = req.headers.origin || `http://localhost:${port}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      success_url: `${origin}/success.html?order_id=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=true`,
      metadata: {
        order_id: orderId,
        customer_name: customer?.name || '',
        customer_phone: customer?.phone || '',
        customer_address: customer?.address || ''
      }
    });

    order.stripeSessionId = session.id;
    order.paymentUrl = session.url || '';

    const orders = await readOrders();
    orders.push(order);
    await writeOrders(orders);

    res.json({ id: session.id, orderId });
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({ error: 'خطأ داخلي في الخادم أثناء إنشاء جلسة الدفع.' });
  }
});

app.get('/orders', async (req, res) => {
  try {
    const orders = await readOrders();
    res.json(orders);
  } catch (error) {
    console.error('Orders fetch error:', error);
    res.status(500).json({ error: 'تعذر جلب الطلبات من الخادم.' });
  }
});

app.listen(port, async () => {
  await ensureOrdersFile();
  console.log(`Server running at http://localhost:${port}`);
});
