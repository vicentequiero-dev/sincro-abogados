const { createHmac } = require("node:crypto");

const FLOW_REQUEST_TIMEOUT_MS = 10000;
const FLOW_ORDER_PATTERN = /^[1-9]\d{0,15}$/;

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function normalizeFlowOrder(value) {
  if (typeof value !== "string") return null;

  const flowOrder = value.trim();
  if (!FLOW_ORDER_PATTERN.test(flowOrder)) return null;

  const numericFlowOrder = Number(flowOrder);
  return Number.isSafeInteger(numericFlowOrder) ? flowOrder : null;
}

function createStatusUrl(flowApiUrl) {
  if (typeof flowApiUrl !== "string" || !flowApiUrl) return null;

  try {
    const baseUrl = new URL(flowApiUrl);
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
      return null;
    }

    const normalizedBase = baseUrl.href.replace(/\/+$/, "");
    return new URL(`${normalizedBase}/payment/getStatusByFlowOrder`);
  } catch {
    return null;
  }
}

function signFlowParameters(parameters, secretKey) {
  const stringToSign = Object.keys(parameters)
    .sort()
    .map((key) => `${key}${parameters[key]}`)
    .join("");

  return createHmac("sha256", secretKey).update(stringToSign).digest("hex");
}

function isValidStatusResponse(value, requestedFlowOrder) {
  const responseFlowOrder =
    typeof value?.flowOrder === "number" &&
    Number.isSafeInteger(value.flowOrder) &&
    value.flowOrder > 0
      ? String(value.flowOrder)
      : null;

  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    responseFlowOrder === requestedFlowOrder &&
    Number.isInteger(value.status) &&
    typeof value.commerceOrder === "string" &&
    value.commerceOrder.length > 0 &&
    value.commerceOrder.length <= 255 &&
    typeof value.amount === "number" &&
    Number.isFinite(value.amount) &&
    value.amount >= 0 &&
    typeof value.currency === "string" &&
    /^[A-Z]{3}$/.test(value.currency)
  );
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { ok: false });
  }

  const flowOrder = normalizeFlowOrder(request.query?.flowOrder);
  if (!flowOrder) {
    return sendJson(response, 400, { ok: false });
  }

  const apiKey = process.env.FLOW_API_KEY;
  const secretKey = process.env.FLOW_SECRET_KEY;
  const statusUrl = createStatusUrl(process.env.FLOW_API_URL);

  if (!apiKey || !secretKey || !statusUrl) {
    return sendJson(response, 500, { ok: false });
  }

  const parameters = { apiKey, flowOrder };
  const signature = signFlowParameters(parameters, secretKey);
  statusUrl.search = new URLSearchParams({ ...parameters, s: signature });

  try {
    const flowResponse = await fetch(statusUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FLOW_REQUEST_TIMEOUT_MS),
    });

    if (!flowResponse.ok) {
      return sendJson(response, 502, { ok: false });
    }

    const flowData = await flowResponse.json();
    if (!isValidStatusResponse(flowData, flowOrder)) {
      return sendJson(response, 502, { ok: false });
    }

    return sendJson(response, 200, {
      ok: true,
      flowOrder: flowData.flowOrder,
      status: flowData.status,
      commerceOrder: flowData.commerceOrder,
      amount: flowData.amount,
      currency: flowData.currency,
    });
  } catch {
    return sendJson(response, 502, { ok: false });
  }
};
