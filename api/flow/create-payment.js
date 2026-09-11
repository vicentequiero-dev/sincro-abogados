const { createHmac } = require("node:crypto");

const RESERVATION_AMOUNT = 15000;
const FLOW_SUBJECT = "Consulta jurídica online - SINCRO Abogados";
const FLOW_REQUEST_TIMEOUT_MS = 12000;
const RPC_REQUEST_TIMEOUT_MS = 10000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function parseRequestBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

function getReservationId(body) {
  const payload = parseRequestBody(body);
  if (!payload || Object.keys(payload).length !== 1) return null;
  if (typeof payload.reservationId !== "string") return null;

  const reservationId = payload.reservationId.trim();
  return UUID_PATTERN.test(reservationId) ? reservationId.toLowerCase() : null;
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

function createRpcUrl(supabaseUrl, functionName) {
  const baseUrl = parseHttpsUrl(supabaseUrl);
  if (!baseUrl) throw new Error("Invalid Supabase URL");
  return new URL(`/rest/v1/rpc/${functionName}`, baseUrl);
}

function createFlowPaymentUrl(flowApiUrl) {
  const baseUrl = parseHttpsUrl(flowApiUrl);
  if (!baseUrl) throw new Error("Invalid Flow URL");

  const normalizedBase = baseUrl.href.replace(/\/+$/, "");
  return new URL(`${normalizedBase}/payment/create`);
}

function validateConfiguration(environment) {
  const requiredValues = [
    environment.FLOW_API_KEY,
    environment.FLOW_SECRET_KEY,
    environment.SUPABASE_SECRET_KEY,
  ];

  if (requiredValues.some((value) => typeof value !== "string" || !value)) {
    return null;
  }

  const flowPaymentUrl = createFlowPaymentUrl(environment.FLOW_API_URL);
  const confirmationUrl = parseHttpsUrl(environment.FLOW_CONFIRMATION_URL);
  const returnUrl = parseHttpsUrl(environment.FLOW_RETURN_URL);
  const supabaseUrl = parseHttpsUrl(environment.SUPABASE_URL);

  if (!confirmationUrl || !returnUrl || !supabaseUrl) return null;

  return {
    flowApiKey: environment.FLOW_API_KEY,
    flowSecretKey: environment.FLOW_SECRET_KEY,
    flowPaymentUrl,
    confirmationUrl: confirmationUrl.href,
    returnUrl: returnUrl.href,
    supabaseUrl: supabaseUrl.href,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  };
}

async function callSupabaseRpc(configuration, functionName, parameters) {
  const rpcResponse = await fetch(
    createRpcUrl(configuration.supabaseUrl, functionName),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        apikey: configuration.supabaseSecretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parameters),
      signal: AbortSignal.timeout(RPC_REQUEST_TIMEOUT_MS),
    },
  );

  if (!rpcResponse.ok) throw new Error("Supabase RPC failed");

  try {
    return await rpcResponse.json();
  } catch {
    throw new Error("Invalid Supabase RPC response");
  }
}

async function claimFlowPayment(configuration, reservationId) {
  const result = await callSupabaseRpc(configuration, "claim_flow_payment", {
    p_reservation_id: reservationId,
  });

  if (!Array.isArray(result) || result.length !== 1 || !result[0]) {
    throw new Error("Invalid claim response");
  }

  return result[0];
}

async function runPaymentStateRpc(
  configuration,
  functionName,
  reservationId,
  attemptId,
  extraParameters = {},
) {
  const result = await callSupabaseRpc(configuration, functionName, {
    p_reservation_id: reservationId,
    p_attempt_id: attemptId,
    ...extraParameters,
  });

  return result === true;
}

function signFlowParameters(parameters, secretKey) {
  const stringToSign = Object.keys(parameters)
    .sort()
    .map((key) => `${key}${parameters[key]}`)
    .join("");

  return createHmac("sha256", secretKey).update(stringToSign).digest("hex");
}

function hasValidFlowSuccessShape(value) {
  const validFlowOrder =
    (typeof value?.flowOrder === "number" &&
      Number.isSafeInteger(value.flowOrder) &&
      value.flowOrder > 0) ||
    (typeof value?.flowOrder === "string" &&
      value.flowOrder.trim().length > 0 &&
      value.flowOrder.length <= 100);

  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.url === "string" &&
    value.url.length > 0 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    value.token.length <= 500 &&
    validFlowOrder
  );
}

function hasValidFlowErrorShape(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.code === "number" &&
    Number.isFinite(value.code) &&
    typeof value.message === "string" &&
    value.message.trim().length > 0
  );
}

function buildCheckoutUrl(url, token) {
  const checkoutBaseUrl = parseHttpsUrl(url);
  if (!checkoutBaseUrl || checkoutBaseUrl.search || checkoutBaseUrl.hash) {
    return null;
  }

  checkoutBaseUrl.searchParams.set("token", token);
  return checkoutBaseUrl.href;
}

async function readJsonSafely(httpResponse) {
  try {
    const value = await httpResponse.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

async function createFlowOrder(configuration, paymentData) {
  const parameters = {
    amount: String(paymentData.amount),
    apiKey: configuration.flowApiKey,
    commerceOrder: paymentData.commerceOrder,
    currency: "CLP",
    email: paymentData.customerEmail,
    paymentMethod: "9",
    subject: FLOW_SUBJECT,
    timeout: String(paymentData.timeout),
    urlConfirmation: configuration.confirmationUrl,
    urlReturn: configuration.returnUrl,
  };

  const requestBody = new URLSearchParams({
    ...parameters,
    s: signFlowParameters(parameters, configuration.flowSecretKey),
  });

  let flowResponse;
  try {
    flowResponse = await fetch(configuration.flowPaymentUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: requestBody,
      signal: AbortSignal.timeout(FLOW_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { outcome: "ambiguous" };
  }

  const responseData = await readJsonSafely(flowResponse);

  if (flowResponse.status === 400 || flowResponse.status === 401) {
    if (hasValidFlowErrorShape(responseData)) {
      return { outcome: "failed" };
    }
    return { outcome: "ambiguous" };
  }

  if (!flowResponse.ok || !hasValidFlowSuccessShape(responseData)) {
    return { outcome: "ambiguous" };
  }

  const checkoutUrl = buildCheckoutUrl(responseData.url, responseData.token);
  if (!checkoutUrl) return { outcome: "ambiguous" };

  return {
    outcome: "created",
    checkoutUrl,
    flowOrder: String(responseData.flowOrder).trim(),
  };
}

function validateCreateClaim(claim) {
  if (
    !UUID_PATTERN.test(claim.attempt_id || "") ||
    typeof claim.commerce_order !== "string" ||
    !claim.commerce_order ||
    claim.commerce_order.length > 255 ||
    claim.amount !== RESERVATION_AMOUNT ||
    typeof claim.customer_email !== "string" ||
    claim.customer_email.length > 254 ||
    !EMAIL_PATTERN.test(claim.customer_email)
  ) {
    return null;
  }

  const holdExpiresAt = new Date(claim.hold_expires_at);
  if (!Number.isFinite(holdExpiresAt.getTime())) return null;

  return {
    amount: claim.amount,
    attemptId: claim.attempt_id,
    commerceOrder: claim.commerce_order,
    customerEmail: claim.customer_email,
    holdExpiresAt,
  };
}

async function markFailed(configuration, reservationId, attemptId) {
  return runPaymentStateRpc(
    configuration,
    "fail_flow_payment",
    reservationId,
    attemptId,
  );
}

async function markAmbiguous(configuration, reservationId, attemptId) {
  try {
    return await runPaymentStateRpc(
      configuration,
      "mark_flow_payment_ambiguous",
      reservationId,
      attemptId,
    );
  } catch {
    return false;
  }
}

function handleClaimDecision(response, claim, reservationId) {
  switch (claim.decision) {
    case "not_found":
      return sendJson(response, 404, {
        ok: false,
        error: "reservation_not_found",
      });
    case "expired":
      return sendJson(response, 409, {
        ok: false,
        error: "reservation_expired",
      });
    case "in_progress":
      return sendJson(response, 409, {
        ok: false,
        error: "payment_in_progress",
      });
    case "ambiguous":
      return sendJson(response, 409, {
        ok: false,
        error: "payment_ambiguous",
      });
    case "invalid_status":
    case "invalid_amount":
    case "invalid_state":
      return sendJson(response, 409, {
        ok: false,
        error: "reservation_unavailable",
      });
    case "reuse": {
      const checkoutUrl = buildCheckoutUrlFromStoredValue(claim.checkout_url);
      if (!checkoutUrl || typeof claim.hold_expires_at !== "string") return null;

      return sendJson(response, 200, {
        ok: true,
        checkoutUrl,
        reservationId,
        holdExpiresAt: claim.hold_expires_at,
      });
    }
    case "create":
      return undefined;
    default:
      return null;
  }
}

function buildCheckoutUrlFromStoredValue(value) {
  const checkoutUrl = parseHttpsUrl(value);
  if (!checkoutUrl || !checkoutUrl.searchParams.has("token")) return null;
  return checkoutUrl.href;
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { ok: false, error: "Method not allowed" });
  }

  const reservationId = getReservationId(request.body);
  if (!reservationId) {
    return sendJson(response, 400, { ok: false, error: "invalid_request" });
  }

  let configuration;
  try {
    configuration = validateConfiguration(process.env);
  } catch {
    configuration = null;
  }

  if (!configuration) {
    return sendJson(response, 500, { ok: false, error: "payment_failed" });
  }

  let claim;
  try {
    claim = await claimFlowPayment(configuration, reservationId);
  } catch {
    return sendJson(response, 500, { ok: false, error: "payment_failed" });
  }

  const decisionResponse = handleClaimDecision(response, claim, reservationId);
  if (decisionResponse !== undefined) {
    return (
      decisionResponse ||
      sendJson(response, 500, { ok: false, error: "payment_failed" })
    );
  }

  const paymentData = validateCreateClaim(claim);
  if (!paymentData) {
    if (UUID_PATTERN.test(claim.attempt_id || "")) {
      try {
        await markFailed(configuration, reservationId, claim.attempt_id);
      } catch {
        // The stale creating state will become ambiguous in the claim RPC.
      }
    }
    return sendJson(response, 500, { ok: false, error: "payment_failed" });
  }

  const timeout = Math.floor(
    (paymentData.holdExpiresAt.getTime() - Date.now()) / 1000,
  );

  if (timeout <= 0) {
    try {
      await markFailed(configuration, reservationId, paymentData.attemptId);
    } catch {
      // No Flow request was sent; a stale claim still transitions to ambiguous.
    }
    return sendJson(response, 409, {
      ok: false,
      error: "reservation_expired",
    });
  }

  const flowResult = await createFlowOrder(configuration, {
    ...paymentData,
    timeout,
  });

  if (flowResult.outcome === "failed") {
    try {
      const failed = await markFailed(
        configuration,
        reservationId,
        paymentData.attemptId,
      );
      if (!failed) throw new Error("Payment state update rejected");
    } catch {
      return sendJson(response, 500, { ok: false, error: "payment_failed" });
    }

    return sendJson(response, 502, {
      ok: false,
      error: "payment_creation_failed",
    });
  }

  if (flowResult.outcome === "ambiguous") {
    await markAmbiguous(configuration, reservationId, paymentData.attemptId);
    return sendJson(response, 502, {
      ok: false,
      error: "payment_creation_ambiguous",
    });
  }

  let completed = false;
  try {
    completed = await runPaymentStateRpc(
      configuration,
      "complete_flow_payment",
      reservationId,
      paymentData.attemptId,
      {
        p_flow_order: flowResult.flowOrder,
        p_checkout_url: flowResult.checkoutUrl,
      },
    );
  } catch {
    completed = false;
  }

  if (!completed) {
    await markAmbiguous(configuration, reservationId, paymentData.attemptId);
    return sendJson(response, 500, {
      ok: false,
      error: "payment_completion_failed",
    });
  }

  return sendJson(response, 200, {
    ok: true,
    checkoutUrl: flowResult.checkoutUrl,
    reservationId,
    holdExpiresAt: paymentData.holdExpiresAt.toISOString(),
  });
};
