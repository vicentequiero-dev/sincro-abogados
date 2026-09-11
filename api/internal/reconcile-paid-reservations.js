const { createHash, timingSafeEqual } = require("node:crypto");
const {
  processCalendarReservation,
} = require("../../lib/calendar/process-reservation");

const MAX_RESERVATIONS = 2;
const RECENT_PAYMENT_MARGIN_MS = 60 * 1000;
const SUPABASE_REQUEST_TIMEOUT_MS = 10000;
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 512;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
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

function isReasonableSecret(value) {
  return (
    typeof value === "string" &&
    value.length >= MIN_SECRET_LENGTH &&
    value.length <= MAX_SECRET_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function getBearerToken(request) {
  const authorization = request.headers?.authorization;
  if (typeof authorization !== "string") return null;

  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(authorization);
  return match ? match[1] : null;
}

function secretsMatch(actual, expected) {
  if (!isReasonableSecret(actual) || !isReasonableSecret(expected)) {
    return false;
  }

  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function getConfiguration(environment) {
  const supabaseUrl = parseHttpsUrl(environment.SUPABASE_URL);
  if (
    !supabaseUrl ||
    !isReasonableSecret(environment.RECONCILER_SECRET) ||
    typeof environment.SUPABASE_SECRET_KEY !== "string" ||
    !environment.SUPABASE_SECRET_KEY
  ) {
    return null;
  }

  return {
    reservationsUrl: new URL("/rest/v1/reservations", supabaseUrl),
    reconcilerSecret: environment.RECONCILER_SECRET,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  };
}

async function getPaidReservationIds(configuration) {
  const cutoff = new Date(Date.now() - RECENT_PAYMENT_MARGIN_MS).toISOString();
  const url = new URL(configuration.reservationsUrl);
  url.searchParams.set("select", "id");
  url.searchParams.set("status", "eq.paid");
  url.searchParams.set("paid_at", `lt.${cutoff}`);
  url.searchParams.set("order", "paid_at.asc");
  url.searchParams.set("limit", String(MAX_RESERVATIONS));

  const databaseResponse = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      apikey: configuration.supabaseSecretKey,
    },
    signal: AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS),
  });

  if (!databaseResponse.ok) {
    throw new Error("Paid reservation query failed");
  }

  let rows;
  try {
    rows = await databaseResponse.json();
  } catch {
    throw new Error("Invalid paid reservation query response");
  }

  if (!Array.isArray(rows) || rows.length > MAX_RESERVATIONS) {
    throw new Error("Invalid paid reservation query response");
  }

  return rows.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.id !== "string" ||
      !UUID_PATTERN.test(row.id)
    ) {
      throw new Error("Invalid paid reservation query response");
    }
    return row.id.toLowerCase();
  });
}

function createStatistics(processed) {
  return {
    ok: true,
    processed,
    confirmed: 0,
    pending: 0,
    needsReview: 0,
    alreadyConfirmed: 0,
    notEligible: 0,
    notFound: 0,
  };
}

function recordOutcome(statistics, outcome) {
  switch (outcome) {
    case "confirmed":
      statistics.confirmed += 1;
      break;
    case "already_confirmed":
      statistics.alreadyConfirmed += 1;
      break;
    case "needs_review":
      statistics.needsReview += 1;
      break;
    case "not_eligible":
      statistics.notEligible += 1;
      break;
    case "not_found":
      statistics.notFound += 1;
      break;
    case "pending":
    default:
      statistics.pending += 1;
  }
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { ok: false });
  }

  const configuration = getConfiguration(process.env);
  if (!configuration) {
    return sendJson(response, 503, { ok: false });
  }

  const bearerToken = getBearerToken(request);
  if (!secretsMatch(bearerToken, configuration.reconcilerSecret)) {
    return sendJson(response, 401, { ok: false });
  }

  let reservationIds;
  try {
    reservationIds = await getPaidReservationIds(configuration);
  } catch {
    return sendJson(response, 502, { ok: false });
  }

  const statistics = createStatistics(reservationIds.length);

  for (const reservationId of reservationIds) {
    try {
      const result = await processCalendarReservation({
        reservationId,
        environment: process.env,
        mode: "full",
      });
      recordOutcome(statistics, result?.outcome);
    } catch {
      statistics.pending += 1;
    }
  }

  return sendJson(response, 200, statistics);
};
