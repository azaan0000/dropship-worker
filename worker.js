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

// Client IP forward karne ke liye req object receive karein ge
async function cjFetch(env, path, options = {}, req = null) {
  const token = await getValidToken(env);
  
  const headers = {
    "CJ-Access-Token": token,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  // Asal user ka IP forward karne ka logic
  if (req) {
    const clientIP = req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For");
    if (clientIP) {
      headers["X-Forwarded-For"] = clientIP;
      headers["Client-IP"] = clientIP;
    }
  }

  const res = await fetch(`${CJ_BASE}${path}`, {
    ...options,
    headers: headers,
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

  // Dynamic cache key
  const cacheKey = `products_cache:${keyword}:${pageNum}:${categoryId}`;
  
  // KV cache check
  const cachedResponse = await env.TOKEN_STORE.get(cacheKey);
  if (cachedResponse) {
    return new Response(cachedResponse, {
      headers: { "Content-Type": "application/json", ...corsHeaders(env), "X-Cache": "HIT" },
    });
  }

  const qs = new URLSearchParams({
    pageNum,
    pageSize: "20",
    ...(keyword ? { productNameEn: keyword } : {}),
    ...(categoryId ? { categoryId } : {}),
  });

  // req object pass kar diya taake IP forward ho sake
  const data = await cjFetch(env, `/product/list?${qs.toString()}`, { method: "GET" }, req);

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

  const finalResponseData = JSON.stringify({ products, total: data.data?.total || 0 });

  // 5 minutes caching
  await env.TOKEN_STORE.put(cacheKey, finalResponseData, { expirationTtl: 300 });

  return new Response(finalResponseData, {
    headers: { "Content-Type": "application/json", ...corsHeaders(env), "X-Cache": "MISS" },
  });
}

async function handleProductDetail(req, env) {
  const url = new URL(req.url);
  const pid = url.searchParams.get("pid");
  if (!pid) return new Response(JSON.stringify({ error: "pid required" }), { status: 400, headers: corsHeaders(env) });

  const cacheKey = `product_detail:${pid}`;
  const cachedDetail = await env.TOKEN_STORE.get(cacheKey);
  if (cachedDetail) {
    return new Response(cachedDetail, {
      headers: { "Content-Type": "application/json", ...corsHeaders(env), "X-Cache": "HIT" },
    });
  }

  // req object pass kar diya taake IP forward ho sake
  const data = await cjFetch(env, `/product/query?pid=${pid}`, { method: "GET" }, req);
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

  const finalDetailData = JSON.stringify({
    id: p.pid,
    name: p.productNameEn,
    description: p.description,
    images: p.productImageSet,
    variants,
  });

  await env.TOKEN_STORE.put(cacheKey, finalDetailData, { expirationTtl: 300 });

  return new Response(finalDetailData, { 
    headers: { "Content-Type": "application/json", ...corsHeaders(env), "X-Cache": "MISS" } 
  });
}

// ---------- Rapid Gateway: get OAuth2 access token ----------
async function getRapidGatewayToken(env) {
  const cached = await env.TOKEN_STORE.get("rg_token", { type: "json" });
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const res = await fetch(`${env.RAPIDGATEWAY_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + btoa(`${env.RAPIDGATEWAY_MERCHANT_ID}:${env.RAPIDGATEWAY_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });

  if (!res.ok) throw new Error("Rapid Gateway auth failed: " + (await res.text()));
  const data = await res.json();

  await env.TOKEN_STORE.put(
    "rg_token",
    JSON.stringify({ accessToken: data.access_token, expiresAt: Date.now() + 55 * 60_000 })
  );
  return data.access_token;
}

// ---------- Checkout: Step 1 - create pending order + Rapid Gateway transaction ----------
async function handleCheckoutCreate(req, env) {
  const body = await req.json();

  const orderNumber = `ORDER-${Date.now()}`;
  const totalAmountPKR = (body.products || []).reduce(
    (sum, p) => sum + (p.sellingPrice || 0) * (p.quantity || 1),
    0
  );

  const orderRecord = { ...body, orderNumber, status: "pending_payment", createdAt: Date.now() };
  await env.TOKEN_STORE.put(`order:${orderNumber}`, JSON.stringify(orderRecord), {
    expirationTtl: 60 * 60 * 24 * 7, 
  });

  const token = await getRapidGatewayToken(env);

  const successUrl = `${env.STORE_ORIGIN}/dropship-store/order-status.html?status=success&ref=${orderNumber}`;
  const failureUrl = `${env.STORE_ORIGIN}/dropship-store/order-status.html?status=failed&ref=${orderNumber}`;
  const checkoutUrlRedirect = `${env.STORE_ORIGIN}/dropship-store/order-status.html?status=complete&ref=${orderNumber}`;

  const txnRes = await fetch(`${env.RAPIDGATEWAY_API_BASE}/rapid/process-transaction`, {
    method: "POST",
    redirect: "manual", 
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      MERCHANT_ID: env.RAPIDGATEWAY_MERCHANT_ID,
      MERCHANT_NAME: env.STORE_NAME || "Drift Store",
      TXNAMT: String(totalAmountPKR),
      CURRENCY_CODE: "PKR",
      CUSTOMER_MOBILE_NO: body.shippingPhone,
      CUSTOMER_EMAIL_ADDRESS: body.email,
      BASKET_ID: orderNumber,
      TXNDESC: `Order ${orderNumber}`,
      ORDER_DATE: new Date().toISOString().slice(0, 10),
      SUCCESS_URL: successUrl,
      FAILURE_URL: failureUrl,
      CHECKOUT_URL: checkoutUrlRedirect,
      VERSION: "MY_VER_1.0",
      PROCCODE: "0",
    }).toString(),
  });

  const checkoutUrl = txnRes.headers.get("Location");
  if (!checkoutUrl) {
    const errText = await txnRes.text().catch(() => "");
    return new Response(
      JSON.stringify({ error: "Payment init failed — no redirect URL returned", detail: errText }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
    );
  }

  return new Response(JSON.stringify({ orderNumber, checkoutUrl }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function pushOrderToCJ(env, orderRecord, req) {
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
    products: orderRecord.products, 
  };

  const data = await cjFetch(env, `/shopping/order/createOrderV2`, {
    method: "POST",
    body: JSON.stringify(payload),
  }, req);
  return data;
}

// ---------- Webhook: signature verification ----------
async function verifyRapidGatewaySignature(req, env, rawBody) {
  const signature = req.headers.get("X-RapidGateway-Signature") || "";
  const timestamp = req.headers.get("X-RapidGateway-Timestamp") || "";
  if (!signature || !timestamp) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.RAPIDGATEWAY_SIGNING_SALT),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${rawBody}`));
  const computedHex = [...new Uint8Array(sigBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

  return computedHex === signature.toUpperCase();
}

// ---------- Checkout: Step 2 - Rapid Gateway webhook confirms payment ----------
async function handlePaymentWebhook(req, env) {
  const rawBody = await req.text();
  const verified = await verifyRapidGatewaySignature(req, env, rawBody);
  if (!verified) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  const body = JSON.parse(rawBody);
  const orderNumber = body.BASKET_ID || body.reference || body.orderNumber;
  const paymentStatus = body.status || body.TXN_STATUS; 

  if (!orderNumber) {
    return new Response(JSON.stringify({ error: "Missing order reference" }), { status: 400 });
  }

  const stored = await env.TOKEN_STORE.get(`order:${orderNumber}`, { type: "json" });
  if (!stored) {
    return new Response(JSON.stringify({ error: "Order not found" }), { status: 404 });
  }

  const isSuccess = ["succeeded", "success", "SUCCESS", "0", "00"].includes(String(paymentStatus));
  if (!isSuccess) {
    stored.status = "payment_failed";
    await env.TOKEN_STORE.put(`order:${orderNumber}`, JSON.stringify(stored));
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  const cjResult = await pushOrderToCJ(env, stored, req);
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

  const data = await cjFetch(env, `/shopping/order/getOrderDetail?orderId=${orderId}`, { method: "GET" }, req);
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
