const { createHash, timingSafeEqual } = require("node:crypto");
const {
  processAdminReservationNotification,
} = require("../../lib/notifications/admin-reservation");

const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 512;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OUTCOMES = new Set([
  "sent",
  "already_sent",
  "pending",
  "manual_review",
  "not_found",
  "not_eligible",
]);

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
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

function parseJsonBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

module.exports = async function handler(request, response) {
  if (process.env.VERCEL_ENV !== "preview") {
    return sendJson(response, 404, { ok: false });
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { ok: false });
  }

  const reconcilerSecret = process.env.RECONCILER_SECRET;
  if (!isReasonableSecret(reconcilerSecret)) {
    return sendJson(response, 503, { ok: false });
  }

  const bearerToken = getBearerToken(request);
  if (!secretsMatch(bearerToken, reconcilerSecret)) {
    return sendJson(response, 401, { ok: false });
  }

  const contentType = request.headers?.["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    return sendJson(response, 400, { ok: false });
  }

  const body = parseJsonBody(request.body);
  if (
    !body ||
    typeof body.reservationId !== "string" ||
    !UUID_PATTERN.test(body.reservationId)
  ) {
    return sendJson(response, 400, { ok: false });
  }

  let result;
  try {
    result = await processAdminReservationNotification({
      reservationId: body.reservationId.toLowerCase(),
      environment: process.env,
    });
  } catch {
    return sendJson(response, 502, { ok: false });
  }

  if (!result || !SAFE_OUTCOMES.has(result.outcome)) {
    return sendJson(response, 502, { ok: false });
  }

  return sendJson(response, 200, {
    ok: true,
    outcome: result.outcome,
  });
};
