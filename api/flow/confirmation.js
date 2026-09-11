const { createHmac } = require("node:crypto");

const PAYMENT_AMOUNT = 15000;
const FLOW_REQUEST_TIMEOUT_MS = 10000;
const SUPABASE_REQUEST_TIMEOUT_MS = 10000;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{10,500}$/;
const FLOW_ORDER_PATTERN = /^[1-9]\d{0,15}$/;
const SUCCESSFUL_CONFIRMATION_DECISIONS = new Set([
  "paid",
  "already_paid",
  "already_confirmed",
  "already_needs_review",
  "late_payment_recovered",
  "late_payment_slot_conflict",
  "payment_requires_review",
]);
const CONSISTENCY_ERROR_DECISIONS = new Set([
  "invalid_payment",
  "identity_mismatch",
  "amount_mismatch",
  "flow_order_conflict",
]);

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function getContentType(request) {
  const value = request.headers?.["content-type"];
  return typeof value === "string" ? value.toLowerCase() : "";
}

function getCallbackToken(request) {
  if (!getContentType(request).startsWith("application/x-www-form-urlencoded")) {
    return null;
  }

  let token;
  if (typeof request.body === "string" || Buffer.isBuffer(request.body)) {
    const values = new URLSearchParams(String(request.body)).getAll("token");
    if (values.length !== 1) return null;
    [token] = values;
  } else if (
    request.body &&
    typeof request.body === "object" &&
    !Array.isArray(request.body) &&
    typeof request.body.token === "string"
  ) {
    token = request.body.token;
  } else {
    return null;
  }

  const normalized = token.trim();
  return TOKEN_PATTERN.test(normalized) ? normalized : null;
}

function parseHttpsUrl(value) {
  if (typeof value !== "string" || !value) return null;

  try {
    const parsedUrl = new URL(value);
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      return null;
    }
    return parsedUrl;
  } catch {
    return null;
  }
}

function createFlowStatusUrl(flowApiUrl) {
  const baseUrl = parseHttpsUrl(flowApiUrl);
  if (!baseUrl) return null;

  const normalizedBase = baseUrl.href.replace(/\/+$/, "");
  return new URL(`${normalizedBase}/payment/getStatus`);
}

function createConfirmPaymentRpcUrl(supabaseUrl) {
  const baseUrl = parseHttpsUrl(supabaseUrl);
  return baseUrl
    ? new URL("/rest/v1/rpc/confirm_flow_payment", baseUrl)
    : null;
}

function signFlowParameters(parameters, secretKey) {
  const stringToSign = Object.keys(parameters)
    .sort()
    .map((key) => `${key}${parameters[key]}`)
    .join("");

  return createHmac("sha256", secretKey).update(stringToSign).digest("hex");
}

function normalizeAmount(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;

  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizeFlowOrder(value) {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";

  return FLOW_ORDER_PATTERN.test(normalized) ? normalized : null;
}

function normalizeCommerceOrder(value) {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9_-]{1,255}$/.test(value) ? value : null;
}

function normalizeFlowPayment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const commerceOrder = normalizeCommerceOrder(value.commerceOrder);
  const flowOrder = normalizeFlowOrder(value.flowOrder);
  const amount = normalizeAmount(value.amount);

  if (
    !Number.isInteger(value.status) ||
    !commerceOrder ||
    !flowOrder ||
    amount === null ||
    typeof value.currency !== "string"
  ) {
    return null;
  }

  return {
    status: value.status,
    commerceOrder,
    flowOrder,
    amount,
    currency: value.currency,
  };
}

function getConfiguration(environment) {
  const flowStatusUrl = createFlowStatusUrl(environment.FLOW_API_URL);
  const confirmPaymentRpcUrl = createConfirmPaymentRpcUrl(
    environment.SUPABASE_URL,
  );
  const requiredSecrets = [
    environment.FLOW_API_KEY,
    environment.FLOW_SECRET_KEY,
    environment.SUPABASE_SECRET_KEY,
  ];

  if (
    !flowStatusUrl ||
    !confirmPaymentRpcUrl ||
    requiredSecrets.some((value) => typeof value !== "string" || !value)
  ) {
    return null;
  }

  return {
    flowApiKey: environment.FLOW_API_KEY,
    flowSecretKey: environment.FLOW_SECRET_KEY,
    flowStatusUrl,
    confirmPaymentRpcUrl,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  };
}

async function getFlowPayment(configuration, token) {
  const parameters = { apiKey: configuration.flowApiKey, token };
  const signature = signFlowParameters(parameters, configuration.flowSecretKey);
  const statusUrl = new URL(configuration.flowStatusUrl);
  statusUrl.search = new URLSearchParams({ ...parameters, s: signature });

  const flowResponse = await fetch(statusUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FLOW_REQUEST_TIMEOUT_MS),
  });

  if (!flowResponse.ok) throw new Error("Flow status request failed");

  let flowData;
  try {
    flowData = await flowResponse.json();
  } catch {
    throw new Error("Invalid Flow response");
  }

  const payment = normalizeFlowPayment(flowData);
  if (!payment) throw new Error("Invalid Flow payment shape");
  return payment;
}

async function confirmFlowPayment(configuration, payment) {
  const databaseResponse = await fetch(configuration.confirmPaymentRpcUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      apikey: configuration.supabaseSecretKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_commerce_order: payment.commerceOrder,
      p_flow_order: payment.flowOrder,
      p_amount: payment.amount,
      p_currency: payment.currency,
    }),
    signal: AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS),
  });

  if (!databaseResponse.ok) {
    throw new Error("Payment confirmation RPC failed");
  }

  let rows;
  try {
    rows = await databaseResponse.json();
  } catch {
    throw new Error("Invalid payment confirmation RPC response");
  }

  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0]?.decision !== "string"
  ) {
    throw new Error("Invalid payment confirmation RPC response");
  }

  return rows[0].decision;
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { ok: false });
  }

  const token = getCallbackToken(request);
  if (!token) return sendJson(response, 400, { ok: false });

  const configuration = getConfiguration(process.env);
  if (!configuration) return sendJson(response, 500, { ok: false });

  let payment;
  try {
    payment = await getFlowPayment(configuration, token);
  } catch {
    return sendJson(response, 502, { ok: false });
  }

  if (payment.status !== 2) {
    return sendJson(response, 200, { ok: true });
  }

  if (payment.amount !== PAYMENT_AMOUNT || payment.currency !== "CLP") {
    return sendJson(response, 409, { ok: false });
  }

  let decision;
  try {
    decision = await confirmFlowPayment(configuration, payment);
  } catch {
    return sendJson(response, 500, { ok: false });
  }

  if (SUCCESSFUL_CONFIRMATION_DECISIONS.has(decision)) {
    return sendJson(response, 200, { ok: true });
  }

  if (decision === "not_found") {
    return sendJson(response, 404, { ok: false });
  }

  if (CONSISTENCY_ERROR_DECISIONS.has(decision)) {
    return sendJson(response, 409, { ok: false });
  }

  return sendJson(response, 500, { ok: false });
};
