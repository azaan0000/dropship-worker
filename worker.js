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

async function handleCreateOrder(req, env) {
  const body = await req.json();
  // Expected body: { orderNumber, shippingCountryCode, shippingAddress, shippingCity,
  //   shippingCustomerName, shippingPhone, shippingZip, products: [{vid, quantity}] }

  const payload = {
    orderNumber: body.orderNumber || `ORD-${Date.now()}`,
    shippingZip: body.shippingZip,
    shippingCountryCode: body.shippingCountryCode,
    shippingCountry: body.shippingCountry,
    shippingProvince: body.shippingProvince,
    shippingCity: body.shippingCity,
    shippingAddress: body.shippingAddress,
    shippingCustomerName: body.shippingCustomerName,
    shippingPhone: body.shippingPhone,
    fromCountryCode: "CN",
    logisticName: body.logisticName || "CJPacket Ordinary",
    products: body.products, // [{ vid, quantity }]
  };

  const data = await cjFetch(env, `/shopping/order/createOrderV2`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return new Response(JSON.stringify(data), {
    status: data.result ? 200 : 500,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
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
      if (url.pathname === "/api/order" && req.method === "POST") return await handleCreateOrder(req, env);
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
