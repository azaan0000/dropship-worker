/**
 * DROPSHIP AUTOMATION - Cloudflare Worker Backend
 * Connects to CJ Dropshipping API, handles token refresh, pricing markup,
 * product listing, and order creation.
 *
 * SETUP:
 * 1. wrangler.toml mein KV namespace bind karein (TOKEN_STORE) - token cache ke liye
 * 2. Secret set karein: wrangler secret put CJ_API_KEY
 * 3. Deploy: wrangler deploy
 *
 * ENV VARS NEEDED:
 * - CJ_API_KEY (secret) - CJ se generate kiya hua API key
 * - MARKUP_PERCENT (plain var, e.g. "40") - kitna % profit margin lagana hai
 * - STORE_ORIGIN (plain var) - aapka storefront URL, CORS ke liye
 */

const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

// ---------- Token Management ----------
async function getValidToken(env) {
  const cached = await env.TOKEN_STORE.get("cj_token", { type: "json" });
  if (cached && new Date(cached.accessTokenExpiryDate) > new Date(Date.now() + 60 * 60 * 1000)) {
    return cached.accessToken;
  }

  // Refresh if we have a refresh token that's still valid
  if (cached && cached.refreshToken && new Date(cached.refreshTokenExpiryDate) > new Date()) {
    const refreshed = await fetch(`${CJ_BASE}/authentication/refreshAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: cached.refreshToken }),
    }).then((r) => r.json());

    if (refreshed.result) {
      await env.TOKEN_STORE.put("cj_token", JSON.stringify(refreshed.data));
      return refreshed.data.accessToken;
    }
  }

  // Fresh token
  const fresh = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: env.CJ_API_KEY }),
  }).then((r) => r.json());

  if (!fresh.result) throw new Error("CJ auth failed: " + fresh.message);
  await env.TOKEN_STORE.put("cj_token", JSON.stringify(fresh.data));
  return fresh.data.accessToken;
}

async function cjFetch(env, path, options = {}) {
  const token = await getValidToken(env);
  const res = await fetch(`${CJ_BASE}${path}`, {
    ...options,
    headers: {
      "CJ-Access-Token": token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res.json();
}

// ---------- Pricing ----------
function applyMarkup(costPrice, env) {
  const pct = parseFloat(env.MARKUP_PERCENT || "40");
  const price = parseFloat(costPrice) * (1 + pct / 100);
  return Math.round(price * 100) / 100;
}

// ---------- Routes ----------
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.STORE_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function handleProducts(req, env) {
  const url = new URL(req.url);
  const keyword = url.searchParams.get("keyword") || "";
  const pageNum = url.searchParams.get("page") || "1";
  const categoryId = url.searchParams.get("categoryId") || "";

  const qs = new URLSearchParams({
    pageNum,
    pageSize: "20",
    ...(keyword ? { productNameEn: keyword } : {}),
    ...(categoryId ? { categoryId } : {}),
  });

  const data = await cjFetch(env, `/product/list?${qs.toString()}`, { method: "GET" });

  if (!data.result) {
    return new Response(JSON.stringify({ error: data.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(env) },
    });
  }

  const products = (data.data?.list || []).map((p) => ({
    id: p.pid,
    name: p.productNameEn,
    image: p.productImage,
    costPrice: p.sellPrice,
    sellingPrice: applyMarkup(p.sellPrice, env),
    stock: p.listedNum || 0,
  }));

  return new Response(JSON.stringify({ products, total: data.data?.total || 0 }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function handleProductDetail(req, env) {
  const url = new URL(req.url);
  const pid = url.searchParams.get("pid");
  if (!pid) return new Response(JSON.stringify({ error: "pid required" }), { status: 400, headers: corsHeaders(env) });

  const data = await cjFetch(env, `/product/query?pid=${pid}`, { method: "GET" });
  if (!data.result) {
    return new Response(JSON.stringify({ error: data.message }), { status: 500, headers: corsHeaders(env) });
  }

  const p = data.data;
  const variants = (p.variants || []).map((v) => ({
    vid: v.vid,
    name: v.variantNameEn,
    costPrice: v.variantSellPrice,
    sellingPrice: applyMarkup(v.variantSellPrice, env),
    image: v.variantImage,
  }));

  return new Response(
    JSON.stringify({
      id: p.pid,
      name: p.productNameEn,
      description: p.description,
      images: p.productImageSet,
      variants,
    }),
    { headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
  );
}

async function pushOrderToCJ(env, orderRecord) {
  // Internal helper: actually places the order with CJ once payment is confirmed.
  const payload = {
    orderNumber: orderRecord.orderNumber,
    shippingZip: orderRecord.shippingZip,
    shippingCountryCode: orderRecord.shippingCountryCode,
    shippingCountry: orderRecord.shippingCountry,
    shippingProvince: orderRecord.shippingProvince,
    shippingCity: orderRecord.shippingCity,
    shippingAddress: orderRecord.shippingAddress,
    shippingCustomerName: orderRecord.shippingCustomerName,
    shippingPhone: orderRecord.shippingPhone,
    fromCountryCode: "CN",
    logisticName: orderRecord.logisticName || "CJPacket Ordinary",
    products: orderRecord.products, // [{ vid, quantity }]
  };

  const data = await cjFetch(env, `/shopping/order/createOrderV2`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return data;
}

// ---------- Checkout: Step 1 - create a pending order + Rapid Gateway payment ----------
async function handleCheckoutCreate(req, env) {
  const body = await req.json();
  // Expected body: { shippingCountryCode, shippingAddress, shippingCity, shippingProvince,
  //   shippingCustomerName, shippingPhone, shippingZip, email, products: [{vid, quantity, sellingPrice}] }

  const orderNumber = `ORD-${Date.now()}`;
  const totalAmountPKR = (body.products || []).reduce(
    (sum, p) => sum + (p.sellingPrice || 0) * (p.quantity || 1),
    0
  );

  // Save the pending order in KV so the webhook can find it once payment succeeds.
  const orderRecord = { ...body, orderNumber, status: "pending_payment", createdAt: Date.now() };
  await env.TOKEN_STORE.put(`order:${orderNumber}`, JSON.stringify(orderRecord), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 days
  });

  // CONFIG: confirm exact endpoint path + auth header format once Rapid Gateway
  // sandbox credentials are issued — this follows their published integration example.
  const rgRes = await fetch(`${env.RAPIDGATEWAY_API_BASE}/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RAPIDGATEWAY_API_KEY}`,
    },
    body: JSON.stringify({
      amount: Math.round(totalAmountPKR * 100), // smallest currency unit (paisa)
      currency: "PKR",
      methods: ["card", "raast", "wallet"],
      reference: orderNumber,
      customer: { email: body.email, phone: body.shippingPhone },
      callback_url: `${env.STORE_ORIGIN}/order-status?ref=${orderNumber}`,
      webhook_url: `${env.WORKER_ORIGIN}/api/webhook/rapidgateway`,
    }),
  });

  if (!rgRes.ok) {
    const errText = await rgRes.text();
    return new Response(JSON.stringify({ error: "Payment init failed", detail: errText }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(env) },
    });
  }

  const rgData = await rgRes.json();
  return new Response(JSON.stringify({ orderNumber, checkoutUrl: rgData.checkout_url }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

// ---------- Checkout: Step 2 - Rapid Gateway webhook confirms payment ----------
async function handlePaymentWebhook(req, env) {
  // CONFIG: replace with Rapid Gateway's actual signature verification once docs are issued.
  const body = await req.json();
  const orderNumber = body.reference;
  const paymentStatus = body.status; // e.g. "succeeded" | "failed"

  if (!orderNumber) {
    return new Response(JSON.stringify({ error: "Missing reference" }), { status: 400 });
  }

  const stored = await env.TOKEN_STORE.get(`order:${orderNumber}`, { type: "json" });
  if (!stored) {
    return new Response(JSON.stringify({ error: "Order not found" }), { status: 404 });
  }

  if (paymentStatus !== "succeeded") {
    stored.status = "payment_failed";
    await env.TOKEN_STORE.put(`order:${orderNumber}`, JSON.stringify(stored));
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  // Payment confirmed — now push the order to CJ automatically.
  const cjResult = await pushOrderToCJ(env, stored);
  stored.status = cjResult.result ? "fulfilled" : "fulfillment_failed";
  stored.cjResult = cjResult;
  await env.TOKEN_STORE.put(`order:${orderNumber}`, JSON.stringify(stored));

  return new Response(JSON.stringify({ received: true, fulfilled: !!cjResult.result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleTrackOrder(req, env) {
  const url = new URL(req.url);
  const orderId = url.searchParams.get("orderId");
  if (!orderId) return new Response(JSON.stringify({ error: "orderId required" }), { status: 400, headers: corsHeaders(env) });

  const data = await cjFetch(env, `/shopping/order/getOrderDetail?orderId=${orderId}`, { method: "GET" });
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

// ---------- Main ----------
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/products") return await handleProducts(req, env);
      if (url.pathname === "/api/product") return await handleProductDetail(req, env);
      if (url.pathname === "/api/checkout" && req.method === "POST") return await handleCheckoutCreate(req, env);
      if (url.pathname === "/api/webhook/rapidgateway" && req.method === "POST") return await handlePaymentWebhook(req, env);
      if (url.pathname === "/api/track") return await handleTrackOrder(req, env);

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders(env) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(env) },
      });
    }
  },
};
