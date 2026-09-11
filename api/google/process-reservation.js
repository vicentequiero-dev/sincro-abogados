const {
  processCalendarReservation,
} = require("../../lib/calendar/process-reservation");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function parseRequestBody(request) {
  const contentType = request.headers?.["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    return null;
  }

  if (typeof request.body === "string" || Buffer.isBuffer(request.body)) {
    try {
      const parsed = JSON.parse(String(request.body));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  return request.body &&
    typeof request.body === "object" &&
    !Array.isArray(request.body)
    ? request.body
    : null;
}

function getReservationId(request) {
  const body = parseRequestBody(request);
  if (!body || Object.keys(body).length !== 1) return null;

  const reservationId = body.reservationId;
  return typeof reservationId === "string" && UUID_PATTERN.test(reservationId)
    ? reservationId.toLowerCase()
    : null;
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { ok: false, error: "method_not_allowed" });
  }

  const reservationId = getReservationId(request);
  if (!reservationId) {
    return sendJson(response, 400, { ok: false, error: "invalid_request" });
  }

  const result = await processCalendarReservation({
    reservationId,
    environment: process.env,
    mode: "full",
  });

  if (
    result.outcome === "confirmed" ||
    result.outcome === "already_confirmed"
  ) {
    return sendJson(response, 200, {
      ok: true,
      reservationId,
      status: "confirmed",
    });
  }

  if (result.outcome === "needs_review") {
    return sendJson(response, 409, {
      ok: false,
      error: "calendar_needs_review",
    });
  }

  if (result.outcome === "not_found") {
    return sendJson(response, 404, {
      ok: false,
      error: "reservation_not_found",
    });
  }

  if (result.outcome === "not_eligible") {
    return sendJson(response, 409, {
      ok: false,
      error: "reservation_not_eligible",
    });
  }

  return sendJson(response, 503, {
    ok: false,
    error: "calendar_pending",
  });
};
