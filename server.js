require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const webpush    = require('web-push');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');

/* ── Web Push ──────────────────────────────────────────────── */
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:acaitrufadoeduarda@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

/* ── Mercado Pago ──────────────────────────────────────────── */
function mpClient() {
  return new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
}

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Supabase ──────────────────────────────────────────────── */
function db() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/* ── Middleware ────────────────────────────────────────────── */
app.use(cors({ origin: '*' }));
app.options('*', cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

/* ── Auth helpers ──────────────────────────────────────────── */
function generateToken() {
  const secret    = process.env.ADMIN_PASSWORD + '_acai_secret';
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 12;
  const hash      = crypto.createHmac('sha256', secret).update(String(expiresAt)).digest('hex');
  return `${hash}.${expiresAt}`;
}

function validateToken(token) {
  if (!token) return false;
  try {
    const [hash, expiresAt] = token.split('.');
    if (!hash || !expiresAt) return false;
    if (parseInt(expiresAt) < Math.floor(Date.now() / 1000)) return false;
    const secret   = process.env.ADMIN_PASSWORD + '_acai_secret';
    const expected = crypto.createHmac('sha256', secret).update(expiresAt).digest('hex');
    return hash === expected;
  } catch { return false; }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!validateToken(token)) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

/* ── Push helper ───────────────────────────────────────────── */
const STATUS_MSG = {
  pago:       { title: '✅ Pagamento confirmado!', body: 'Seu açaí está na fila de preparo.' },
  preparando: { title: '🍧 Preparando seu açaí!', body: 'Estamos fazendo com muito carinho!' },
  pronto:     { title: '🎉 Pedido pronto!',        body: 'Seu açaí está pronto para retirada/entrega.' },
  a_caminho:  { title: '🛵 A caminho!',            body: 'O motoboy saiu com seu açaí!' },
  entregue:   { title: '🎊 Entregue!',             body: 'Bom apetite! Obrigada pela preferência 💜' },
  cancelado:  { title: '❌ Pedido cancelado',      body: 'Entre em contato conosco se tiver dúvidas.' },
};

async function sendPushToUser(phone, status, orderId) {
  if (!STATUS_MSG[status] || !phone) return;
  const supabase = db();
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('subscription')
    .eq('user_id', phone);
  if (!subs?.length) return;
  const { title, body } = STATUS_MSG[status];
  const payload = JSON.stringify({ title, body, orderId });
  for (const row of subs) {
    try {
      await webpush.sendNotification(row.subscription, payload);
    } catch (e) {
      if (e.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('user_id', phone);
      }
    }
  }
}

/* ════════════════════════════════════════════════════════════
   AUTH
════════════════════════════════════════════════════════════ */
app.post('/api/auth', async (req, res) => {
  const { email, password } = req.body;
  const adminEmail    = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword)
    return res.status(500).json({ error: 'Servidor não configurado' });

  const emailOk    = email?.toLowerCase().trim() === adminEmail.toLowerCase().trim();
  const passwordOk = password === adminPassword;

  if (!emailOk || !passwordOk) {
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  res.json({ token: generateToken() });
});

/* ════════════════════════════════════════════════════════════
   PRODUTOS
════════════════════════════════════════════════════════════ */
app.get('/api/products', async (req, res) => {
  const { data, error } = await db()
    .from('products')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

app.put('/api/products', requireAdmin, async (req, res) => {
  const products = req.body;
  const supabase = db();

  await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  if (!products.length) return res.json({ ok: true });

  const rows = products.map(p => ({
    name:         p.name,
    description:  p.description ?? p.desc ?? '',
    image_base64: p.imageBase64 ?? null,
    active:       p.active ?? true,
    groups:       p.groups ?? [],
  }));

  const { error } = await supabase.from('products').insert(rows);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════
   PEDIDOS
════════════════════════════════════════════════════════════ */
app.post('/api/orders', async (req, res) => {
  const { customerName, customerPhone, productName, summary, deliveryMethod, total } = req.body;

  if (!customerName || !customerPhone || !productName || !deliveryMethod)
    return res.status(400).json({ error: 'Dados incompletos' });

  /* ── Gera PIX real via Mercado Pago ── */
  let pixCode = null;
  let mpPaymentId = null;

  if (process.env.MP_ACCESS_TOKEN) {
    try {
      const payment = new Payment(mpClient());
      const result  = await payment.create({
        body: {
          transaction_amount: Number(total),
          description:        `Açaí Trufado - ${productName}`,
          payment_method_id:  'pix',
          payer: {
            email:        'cliente@acaitrufado.com',
            first_name:   customerName.split(' ')[0],
            last_name:    customerName.split(' ').slice(1).join(' ') || 'Cliente',
            identification: { type: 'CPF', number: '00000000000' },
          },
        },
        requestOptions: { idempotencyKey: `${customerPhone}-${Date.now()}` },
      });
      pixCode     = result.point_of_interaction?.transaction_data?.qr_code ?? null;
      mpPaymentId = String(result.id ?? '');
    } catch (e) {
      console.error('MP PIX error:', e?.message ?? e);
    }
  }

  const { data, error } = await db()
    .from('orders')
    .insert({
      customer_name:   customerName,
      customer_phone:  customerPhone,
      product_name:    productName,
      summary:         summary ?? [],
      delivery_method: deliveryMethod,
      total:           total ?? 0,
      pix_code:        pixCode,
      mp_payment_id:   mpPaymentId,
      status:          'aguardando_pix',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ...data, pixCode });
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  const { data, error } = await db()
    .from('orders')
    .select('*')
    .not('status', 'in', '("concluido","cancelado")')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/orders/:id/status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, motoboy_lat, motoboy_lng } = req.body;

  const VALID = ['pendente','pago','preparando','pronto','a_caminho','entregue','cancelado','aguardando_pix'];
  if (!VALID.includes(status))
    return res.status(400).json({ error: 'Status inválido' });

  const update = { status };
  if (motoboy_lat != null) update.motoboy_lat = motoboy_lat;
  if (motoboy_lng != null) update.motoboy_lng = motoboy_lng;

  const { data, error } = await db()
    .from('orders')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await sendPushToUser(data?.customer_phone, status, id);

  res.json(data);
});

app.get('/api/orders/active/:userId', async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await db()
    .from('orders')
    .select('*')
    .eq('customer_phone', userId)
    .not('status', 'in', '("entregue","cancelado")')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data?.[0] ?? null);
});

/* ════════════════════════════════════════════════════════════
   WEBHOOK MERCADO PAGO
════════════════════════════════════════════════════════════ */
app.post('/api/webhook/mercadopago', async (req, res) => {
  res.sendStatus(200);

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;

  try {
    const payment = new Payment(mpClient());
    const info    = await payment.get({ id: data.id });

    if (info.status !== 'approved') return;

    const supabase   = db();
    const paymentId  = String(info.id);

    const { data: orders } = await supabase
      .from('orders')
      .select('id, customer_phone')
      .eq('mp_payment_id', paymentId)
      .limit(1);

    if (!orders?.length) return;

    const order = orders[0];

    await supabase
      .from('orders')
      .update({ status: 'pago' })
      .eq('id', order.id);

    await sendPushToUser(order.customer_phone, 'pago', order.id);
  } catch (e) {
    console.error('Webhook MP error:', e?.message ?? e);
  }
});

/* ════════════════════════════════════════════════════════════
   PUSH SUBSCRIPTIONS
════════════════════════════════════════════════════════════ */
app.post('/api/push/subscribe', async (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription) return res.status(400).json({ error: 'Dados incompletos' });

  const supabase = db();
  await supabase.from('push_subscriptions').delete().eq('user_id', userId);
  const { error } = await supabase.from('push_subscriptions').insert({ user_id: userId, subscription });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/push/vapid-public-key', (_, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY ?? '' });
});

/* ── Health check ──────────────────────────────────────────── */
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
