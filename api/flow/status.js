const { createHmac } = require("node:crypto");

const FLOW_REQUEST_TIMEOUT_MS = 10000;
const FLOW_ORDER_PATTERN = /^[1-9]\d{0,15}$/;

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function sendDiagnostic(
  response,
  statusCode,
  stage,
  { flowHttpStatus = 0, flowErrorCode = null, flowErrorMessage = null, fieldTypes } = {},
) {
  const body = {
    ok: false,
    stage,
    flowHttpStatus,
    flowErrorCode,
    flowErrorMessage,
  };

  if (fieldTypes) body.fieldTypes = fieldTypes;
  return sendJson(response, statusCode, body);
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

function sanitizeFlowErrorMessage(message, sensitiveValues) {
  const normalized = message
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length > 500) return null;

  const containsSensitiveValue = sensitiveValues.some(
    (value) => typeof value === "string" && value && normalized.includes(value),
  );
  const containsSensitiveContext =
    /https?:\/\/|\b(?:api\s*key|apikey|secret(?:\s*key)?|signature|token)\b|(?:^|[?&])s=/i.test(
      normalized,
    );

  if (containsSensitiveValue || containsSensitiveContext) {
    return "Flow request rejected";
  }

  return normalized.slice(0, 200);
}

function getOfficialFlowError(value, sensitiveValues) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.code !== "number" ||
    !Number.isFinite(value.code) ||
    typeof value.message !== "string"
  ) {
    return null;
  }

  const message = sanitizeFlowErrorMessage(value.message, sensitiveValues);
  return message ? { code: value.code, message } : null;
}

function getSafeFieldTypes(value) {
  const typeOf = (field) => {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return "missing";
    if (value[field] === null) return "null";
    if (Array.isArray(value[field])) return "array";
    return typeof value[field];
  };

  return {
    flowOrder: typeOf("flowOrder"),
    status: typeOf("status"),
    commerceOrder: typeOf("commerceOrder"),
    amount: typeOf("amount"),
    currency: typeOf("currency"),
  };
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
    return sendDiagnostic(response, 405, "invalid_request");
  }

  const flowOrder = normalizeFlowOrder(request.query?.flowOrder);
  if (!flowOrder) {
    return sendDiagnostic(response, 400, "invalid_request");
  }

  const apiKey = process.env.FLOW_API_KEY;
  const secretKey = process.env.FLOW_SECRET_KEY;
  const statusUrl = createStatusUrl(process.env.FLOW_API_URL);

  if (!apiKey || !secretKey || !statusUrl) {
    return sendDiagnostic(response, 500, "configuration");
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

    let flowData;
    try {
      flowData = await flowResponse.json();
    } catch {
      return sendDiagnostic(response, 502, "flow_invalid_json", {
        flowHttpStatus: flowResponse.status,
      });
    }

    if (!flowResponse.ok) {
      const officialError =
        flowResponse.status === 400 || flowResponse.status === 401
          ? getOfficialFlowError(flowData, [apiKey, secretKey, signature])
          : null;

      return sendDiagnostic(response, 502, "flow_http_error", {
        flowHttpStatus: flowResponse.status,
        flowErrorCode: officialError?.code ?? null,
        flowErrorMessage: officialError?.message ?? null,
      });
    }

    if (!isValidStatusResponse(flowData, flowOrder)) {
      const fieldTypes =
        flowData && typeof flowData === "object" && !Array.isArray(flowData)
          ? getSafeFieldTypes(flowData)
          : null;

      return sendDiagnostic(response, 502, "flow_invalid_shape", {
        flowHttpStatus: flowResponse.status,
        fieldTypes,
      });
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
    return sendDiagnostic(response, 502, "network_error");
  }
};
