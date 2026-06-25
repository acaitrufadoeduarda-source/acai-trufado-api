require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
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

function geraCPF() {
  const rnd = (n) => Math.round(Math.random() * n);
  const mod = (base, div) => Math.round(base - Math.floor(base / div) * div);
  const n = Array(9).fill(0).map(() => rnd(9));
  let d1 = n.reduce((total, num, i) => total + (num * (10 - i)), 0);
  d1 = 11 - mod(d1, 11); if (d1 >= 10) d1 = 0;
  let d2 = n.reduce((total, num, i) => total + (num * (11 - i)), 0) + (d1 * 2);
  d2 = 11 - mod(d2, 11); if (d2 >= 10) d2 = 0;
  return `${n.join('')}${d1}${d2}`;
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
app.set('trust proxy', 1); // Render fica atrás de proxy (necessário p/ rate-limit por IP)

// CORS — aceita só os domínios oficiais (e requisições sem Origin: webhook, curl, server-to-server)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['https://public-eta-eight-82.vercel.app']);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origem não permitida pelo CORS'));
  },
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

/* ── Rate limiting ─────────────────────────────────────────── */
// Brute-force na senha: 5 tentativas / 15 min por IP
const authLimiter  = rateLimit({ windowMs: 15 * 60 * 1000, max: 5,   standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas de login. Aguarde alguns minutos.' } });
// Flood de pedidos: 10 pedidos / 10 min por IP
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10,  standardHeaders: true, legacyHeaders: false, message: { error: 'Muitos pedidos em sequência. Aguarde um pouco.' } });
// Limite geral de respiro: 120 req / min por IP
const apiLimiter   = rateLimit({ windowMs: 60 * 1000,      max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

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
app.post('/api/auth', authLimiter, async (req, res) => {
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

  // Lista vazia: limpa tudo (intencional)
  if (!products.length) {
    await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    return res.json({ ok: true });
  }

  function montaRows(comPrice) {
    return products.map(p => {
      const row = {
        name:         p.name,
        description:  p.description ?? p.desc ?? '',
        image_base64: p.imageBase64 ?? null,
        active:       p.active ?? true,
        groups:       p.groups ?? [],
      };
      if (comPrice) row.price = p.price ?? 0;
      return row;
    });
  }

  // 1) Guarda os ids atuais para apagar SÓ depois que a inserção der certo
  const { data: existing } = await supabase.from('products').select('id');

  // 2) Insere os novos PRIMEIRO (não destrói nada ainda)
  let { error } = await supabase.from('products').insert(montaRows(true));

  // Se falhar por causa da coluna price (ainda não criada), tenta sem ela
  if (error && /price/i.test(error.message || '')) {
    console.warn('Coluna price ausente — inserindo sem price:', error.message);
    ({ error } = await supabase.from('products').insert(montaRows(false)));
  }

  // 3) Se ainda assim falhou, ABORTA sem apagar nada (dados preservados)
  if (error) {
    console.error('Insert de produtos falhou — preservando os existentes:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // 4) Inserção OK → agora sim apaga os antigos
  if (existing?.length) {
    await supabase.from('products').delete().in('id', existing.map(e => e.id));
  }

  res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════
   PEDIDOS
════════════════════════════════════════════════════════════ */
app.post('/api/orders', orderLimiter, async (req, res) => {
  const { customerName, customerPhone, productId, productName, summary, deliveryMethod } = req.body;

  if (!customerName || !customerPhone || !deliveryMethod)
    return res.status(400).json({ error: 'Dados incompletos' });

  // Sanitização básica dos campos livres
  const nome  = String(customerName).trim().slice(0, 80);
  const fone  = String(customerPhone).replace(/\D/g, '').slice(0, 15);
  if (!nome || fone.length < 10) return res.status(400).json({ error: 'Nome ou telefone inválido' });

  /* ── Busca o produto REAL no banco e RECALCULA o total no servidor ──
     Nunca confiamos no "total" enviado pelo cliente (evita manipulação de preço). */
  const supabase = db();
  let prod = null;
  if (productId) {
    ({ data: prod } = await supabase.from('products').select('name, price, groups, active').eq('id', productId).single());
  }
  // Fallback por nome (compatibilidade com clientes antigos)
  if (!prod && productName) {
    ({ data: prod } = await supabase.from('products').select('name, price, groups, active').eq('name', productName).limit(1).single());
  }
  if (!prod || prod.active === false)
    return res.status(400).json({ error: 'Produto indisponível' });

  let total = Number(prod.price) || 0;
  const summarySeguro = [];
  for (const g of (Array.isArray(summary) ? summary : [])) {
    const grupoReal = (prod.groups || []).find(x => x.name === g.groupName);
    if (!grupoReal) continue;
    const opcoes = [];
    for (const o of (g.options || [])) {
      const optReal = (grupoReal.options || []).find(x => x.name === o.name);
      if (!optReal) continue; // ignora opções inexistentes
      const qty = Math.max(1, Math.min(99, parseInt(o.qty) || 1));
      total += (Number(optReal.price) || 0) * qty;
      opcoes.push({ name: optReal.name, qty, price: Number(optReal.price) || 0 });
    }
    if (opcoes.length) summarySeguro.push({ groupName: grupoReal.name, options: opcoes });
  }
  total = Math.round(total * 100) / 100;
  if (total <= 0) return res.status(400).json({ error: 'Total inválido' });

  /* ── Gera PIX real via Mercado Pago (com o total CALCULADO no servidor) ── */
  let pixCode = null;
  let mpPaymentId = null;

  if (process.env.MP_ACCESS_TOKEN) {
    try {
      const payment = new Payment(mpClient());
      const randomPart = Math.floor(Math.random() * 10000);
      const result  = await payment.create({
        body: {
          transaction_amount: total,
          description:        `Pedido Açaí Trufado - ${prod.name}`,
          payment_method_id:  'pix',
          payer: {
            email:          `cliente_${randomPart}@acaitrufado.com`,
            first_name:     nome.split(' ')[0] || 'Cliente',
            last_name:      nome.split(' ').slice(1).join(' ') || 'Cliente',
            identification: { type: 'CPF', number: geraCPF() },
          },
          notification_url: 'https://acai-trufado-api.onrender.com/api/webhook/mercadopago',
        },
        requestOptions: { idempotencyKey: `order_${fone}_${Date.now()}` },
      });
      pixCode     = result.point_of_interaction?.transaction_data?.qr_code ?? null;
      mpPaymentId = String(result.id ?? '');
      console.log(`✅ PIX gerado: payment_id=${mpPaymentId}, qr_code=${pixCode ? 'OK' : 'VAZIO'}`);
    } catch (e) {
      console.error('MP PIX error:', e?.message ?? e);
    }
  }

  const { data, error } = await supabase
    .from('orders')
    .insert({
      customer_name:   nome,
      customer_phone:  fone,
      product_name:    prod.name,
      summary:         summarySeguro,
      delivery_method: deliveryMethod,
      total,
      pix_code:        pixCode,
      mp_payment_id:   mpPaymentId,
      status:          'aguardando_pix',
    })
    .select()
    .single();

  if (error) {
    console.error('❌ Supabase insert error:', JSON.stringify(error));
    return res.status(500).json({ error: error.message });
  }
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

// Histórico — pedidos concluídos/cancelados (fonte de verdade: Supabase)
app.get('/api/orders/history', requireAdmin, async (req, res) => {
  const { data, error } = await db()
    .from('orders')
    .select('*')
    .in('status', ['concluido', 'cancelado'])
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Relatório — TODOS os pedidos (inclui concluído/cancelado), filtrado por data
app.get('/api/orders/report', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  let query = db()
    .from('orders')
    .select('id, product_name, summary, total, status, created_at, delivery_method')
    .order('created_at', { ascending: false });

  if (from) query = query.gte('created_at', from);
  if (to)   query = query.lte('created_at', to);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/orders/:id/status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, motoboy_lat, motoboy_lng } = req.body;

  const VALID = ['pendente','pago','preparando','pronto','a_caminho','motoboy_a_caminho','entregue','concluido','cancelado','aguardando_pix'];
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

// Tracking público pelo UUID do pedido (capability URL — o id é o "segredo").
// Devolve apenas o necessário; NUNCA telefone, nome ou id de pagamento de terceiros.
app.get('/api/orders/:id', async (req, res) => {
  const { data, error } = await db()
    .from('orders')
    .select('id, status, product_name, summary, total, delivery_method, created_at, motoboy_lat, motoboy_lng, pix_code')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Pedido não encontrado' });
  res.json(data);
});

// (Removido) GET /api/orders/active/:userId — expunha pedidos por telefone (IDOR enumerável).
// O cliente agora rastreia apenas pelo UUID salvo localmente (acai_active_order).

/* ════════════════════════════════════════════════════════════
   WEBHOOK MERCADO PAGO
════════════════════════════════════════════════════════════ */
// Valida o header x-signature do Mercado Pago (evita webhook forjado / flood)
function validaAssinaturaMP(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return null; // não configurado ainda → pula validação (com aviso)
  try {
    const sig   = req.headers['x-signature'];
    const reqId = req.headers['x-request-id'];
    const dataId = req.query['data.id'] || req.body?.data?.id;
    if (!sig || !dataId) return false;
    const parts = Object.fromEntries(sig.split(',').map(p => p.split('=').map(s => s.trim())));
    if (!parts.ts || !parts.v1) return false;
    const manifest = `id:${dataId};request-id:${reqId};ts:${parts.ts};`;
    const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    const a = Buffer.from(hmac), b = Buffer.from(parts.v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

app.post('/api/webhook/mercadopago', async (req, res) => {
  // Verifica assinatura ANTES de responder
  const assinatura = validaAssinaturaMP(req);
  if (assinatura === false) {
    console.warn('⚠️ Webhook MP com assinatura inválida — ignorado');
    return res.sendStatus(401);
  }
  if (assinatura === null) {
    console.warn('⚠️ MP_WEBHOOK_SECRET não configurado — webhook aceito sem validar assinatura');
  }

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

/* ════════════════════════════════════════════════════════════
   CONFIGURAÇÕES DA LOJA (open/closed/auto)
   — fallback em memória se tabela ainda não existir no Supabase
════════════════════════════════════════════════════════════ */
let settingsMemory = { modo: 'fechado', dias: [], horaIni: '14:00', horaFim: '22:00' };

// Tenta carregar do Supabase na inicialização
(async () => {
  try {
    const supabase = db();
    const { data } = await supabase
      .from('store_settings')
      .select('value')
      .eq('key', 'loja_config')
      .single();
    if (data?.value) settingsMemory = data.value;
  } catch { /* tabela ainda não existe — usa memória */ }
})();

// Lê config — público (cliente usa para saber se loja está aberta)
app.get('/api/settings', async (req, res) => {
  try {
    const supabase = db();
    const { data, error } = await supabase
      .from('store_settings')
      .select('value')
      .eq('key', 'loja_config')
      .single();
    // PGRST116 = linha não encontrada; qualquer outro erro = tabela não existe
    if (!error) {
      settingsMemory = data.value;
      return res.json(data.value);
    }
  } catch { /* sem tabela, cai no fallback */ }
  res.json(settingsMemory);
});

// Salva config — só admin
app.put('/api/settings', requireAdmin, async (req, res) => {
  // sempre salva em memória imediatamente
  settingsMemory = req.body;
  try {
    const supabase = db();
    const { error } = await supabase
      .from('store_settings')
      .upsert({ key: 'loja_config', value: req.body }, { onConflict: 'key' });
    if (error) {
      // Tabela não existe — retorna 200 mesmo assim (memória já foi salva)
      console.warn('store_settings não existe no Supabase:', error.message);
    }
  } catch (e) {
    console.warn('Erro ao salvar settings no Supabase:', e.message);
  }
  res.json({ ok: true });
});

/* ── Health check ──────────────────────────────────────────── */
app.get('/health', (_, res) => res.json({ ok: true }));

/* ── Tratador de erro (ex.: origem bloqueada pelo CORS) ──────── */
app.use((err, req, res, _next) => {
  if (err && /CORS/i.test(err.message || '')) {
    return res.status(403).json({ error: 'Origem não permitida' });
  }
  console.error('Erro não tratado:', err?.message ?? err);
  res.status(500).json({ error: 'Erro interno' });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
