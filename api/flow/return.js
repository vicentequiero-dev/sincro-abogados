const { createHmac } = require("node:crypto");

const PAYMENT_AMOUNT = 15000;
const FLOW_REQUEST_TIMEOUT_MS = 10000;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{10,500}$/;
const FLOW_ORDER_PATTERN = /^[1-9]\d{0,15}$/;
const COMMERCE_ORDER_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

const PAGE_STATES = {
  paid: {
    accent: "#217a4b",
    symbol: "✓",
    title: "Pago recibido",
    message:
      "Tu pago de $15.000 fue recibido correctamente. Estamos preparando la confirmación de tu consulta.",
  },
  pending: {
    accent: "#9a6a16",
    symbol: "…",
    title: "Pago pendiente",
    message:
      "Tu pago todavía está siendo procesado. Te enviaremos la confirmación cuando esté listo.",
  },
  incomplete: {
    accent: "#751318",
    symbol: "×",
    title: "Pago no completado",
    message:
      "No pudimos confirmar el pago. Puedes volver al sitio e intentarlo nuevamente si corresponde.",
  },
  verifying: {
    accent: "#21324d",
    symbol: "i",
    title: "Estamos verificando tu pago",
    message:
      "No pudimos consultar el estado en este momento. Si realizaste el pago, no vuelvas a pagar inmediatamente.",
  },
};

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

function getConfiguration(environment) {
  const flowStatusUrl = createFlowStatusUrl(environment.FLOW_API_URL);
  const requiredSecrets = [environment.FLOW_API_KEY, environment.FLOW_SECRET_KEY];

  if (
    !flowStatusUrl ||
    requiredSecrets.some((value) => typeof value !== "string" || !value)
  ) {
    return null;
  }

  return {
    flowApiKey: environment.FLOW_API_KEY,
    flowSecretKey: environment.FLOW_SECRET_KEY,
    flowStatusUrl,
    siteUrl: parseHttpsUrl(environment.SITE_URL),
  };
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

function normalizeFlowPayment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const amount = normalizeAmount(value.amount);
  const flowOrder = normalizeFlowOrder(value.flowOrder);
  const commerceOrder =
    typeof value.commerceOrder === "string" &&
    COMMERCE_ORDER_PATTERN.test(value.commerceOrder)
      ? value.commerceOrder
      : null;

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
    amount,
    currency: value.currency,
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(stateName, siteUrl) {
  const state = PAGE_STATES[stateName];
  const returnButton = siteUrl
    ? `<a class="button" href="${escapeHtml(siteUrl.href)}">Volver a SINCRO Abogados</a>`
    : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(state.title)} | SINCRO Abogados</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f6f3ee;
      color: #162238;
      font-family: Arial, Helvetica, sans-serif;
    }
    main {
      width: min(100%, 620px);
      padding: clamp(32px, 7vw, 56px);
      border: 1px solid #e4ddd3;
      border-radius: 18px;
      background: #ffffff;
      box-shadow: 0 18px 50px rgba(22, 34, 56, 0.11);
      text-align: center;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      border: 2px solid ${state.accent};
      border-radius: 50%;
      color: ${state.accent};
      font-family: Georgia, "Times New Roman", serif;
      font-size: 34px;
      font-weight: 700;
    }
    .brand {
      margin: 0 0 12px;
      color: #751318;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      color: #1b2c47;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(30px, 6vw, 42px);
      line-height: 1.12;
    }
    p {
      margin: 20px auto 0;
      max-width: 480px;
      color: #526078;
      font-size: 17px;
      line-height: 1.65;
    }
    .button {
      display: inline-block;
      margin-top: 32px;
      padding: 14px 22px;
      border-radius: 8px;
      background: #751318;
      color: #ffffff;
      font-size: 15px;
      font-weight: 700;
      text-decoration: none;
    }
    .button:hover, .button:focus-visible { background: #5e0f13; }
    .button:focus-visible { outline: 3px solid #caa66b; outline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">${escapeHtml(state.symbol)}</div>
    <div class="brand">SINCRO Abogados</div>
    <h1>${escapeHtml(state.title)}</h1>
    <p>${escapeHtml(state.message)}</p>
    ${returnButton}
  </main>
</body>
</html>`;
}

function sendPage(response, statusCode, stateName, siteUrl = null) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  return response.status(statusCode).send(renderPage(stateName, siteUrl));
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendPage(response, 405, "verifying");
  }

  const token = getCallbackToken(request);
  if (!token) return sendPage(response, 400, "verifying");

  const configuration = getConfiguration(process.env);
  if (!configuration) return sendPage(response, 500, "verifying");

  let payment;
  try {
    payment = await getFlowPayment(configuration, token);
  } catch {
    return sendPage(response, 502, "verifying", configuration.siteUrl);
  }

  if (payment.amount !== PAYMENT_AMOUNT || payment.currency !== "CLP") {
    return sendPage(response, 409, "verifying", configuration.siteUrl);
  }

  if (payment.status === 2) {
    return sendPage(response, 200, "paid", configuration.siteUrl);
  }

  if (payment.status === 1) {
    return sendPage(response, 200, "pending", configuration.siteUrl);
  }

  return sendPage(response, 200, "incomplete", configuration.siteUrl);
};
