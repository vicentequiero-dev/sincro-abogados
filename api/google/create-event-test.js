const { createHash } = require("node:crypto");

const TIME_ZONE = "America/Santiago";
const EVENT_SUMMARY = "Consulta jurídica online - SINCRO Abogados";
const EVENT_DESCRIPTION =
  "Consulta jurídica online agendada con SINCRO Abogados.";
const SLOT_DURATION_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MEET_POLL_DELAYS_MS = [250, 500, 1000, 2000];
const EVENT_RECONCILIATION_DELAYS_MS = [0, 250, 500, 1000];
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

function getConfiguration(environment) {
  const supabaseUrl = parseHttpsUrl(environment.SUPABASE_URL);
  const requiredSecrets = [
    environment.SUPABASE_SECRET_KEY,
    environment.GOOGLE_CLIENT_ID,
    environment.GOOGLE_CLIENT_SECRET,
    environment.GOOGLE_REFRESH_TOKEN,
  ];

  if (
    !supabaseUrl ||
    requiredSecrets.some((value) => typeof value !== "string" || !value)
  ) {
    return null;
  }

  return {
    reservationsUrl: new URL("/rest/v1/reservations", supabaseUrl),
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    googleClientId: environment.GOOGLE_CLIENT_ID,
    googleClientSecret: environment.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: environment.GOOGLE_REFRESH_TOKEN,
  };
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeReservation(row, expectedId) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;

  const id =
    typeof row.id === "string" && UUID_PATTERN.test(row.id)
      ? row.id.toLowerCase()
      : null;
  const customerEmail = normalizeEmail(row.customer_email);
  const startDate = parseTimestamp(row.start_at);
  const endDate = parseTimestamp(row.end_at);

  if (
    id !== expectedId ||
    row.status !== "paid" ||
    !customerEmail ||
    !startDate ||
    !endDate ||
    endDate.getTime() - startDate.getTime() !== SLOT_DURATION_MS
  ) {
    return null;
  }

  return {
    id,
    customerEmail,
    startAt: row.start_at,
    endAt: row.end_at,
    startTime: startDate.getTime(),
    endTime: endDate.getTime(),
  };
}

async function getReservation(configuration, reservationId) {
  const url = new URL(configuration.reservationsUrl);
  url.searchParams.set(
    "select",
    "id,status,customer_email,start_at,end_at",
  );
  url.searchParams.set("id", `eq.${reservationId}`);
  url.searchParams.set("limit", "2");

  const databaseResponse = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      apikey: configuration.supabaseSecretKey,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!databaseResponse.ok) throw new Error("Reservation lookup failed");

  let rows;
  try {
    rows = await databaseResponse.json();
  } catch {
    throw new Error("Invalid reservation response");
  }

  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("Invalid reservation response");
  }

  return rows[0] || null;
}

async function getGoogleAccessToken(configuration) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: configuration.googleClientId,
      client_secret: configuration.googleClientSecret,
      grant_type: "refresh_token",
      refresh_token: configuration.googleRefreshToken,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!tokenResponse.ok) throw new Error("Token refresh failed");

  let tokenData;
  try {
    tokenData = await tokenResponse.json();
  } catch {
    throw new Error("Invalid token response");
  }

  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new Error("Access token missing");
  }

  return tokenData.access_token;
}

function createEventId(reservationId) {
  return `sincro${reservationId.replaceAll("-", "")}`;
}

function createMeetRequestId(reservationId) {
  return createHash("sha256")
    .update(`sincro-meet-v1:${reservationId}`)
    .digest("hex");
}

function createGoogleEventUrl(eventId) {
  return new URL(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
  );
}

function createGoogleEventsUrl() {
  const url = new URL(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  );
  url.searchParams.set("conferenceDataVersion", "1");
  url.searchParams.set("sendUpdates", "all");
  return url;
}

async function readJson(response, errorMessage) {
  try {
    return await response.json();
  } catch {
    throw new Error(errorMessage);
  }
}

async function fetchGoogleEvent(accessToken, eventId) {
  const googleResponse = await fetch(createGoogleEventUrl(eventId), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (googleResponse.status === 404) return null;
  if (!googleResponse.ok) throw new Error("Calendar event lookup failed");
  return readJson(googleResponse, "Invalid Calendar event response");
}

function createGoogleEventBody(reservation, eventId) {
  return {
    id: eventId,
    summary: EVENT_SUMMARY,
    description: EVENT_DESCRIPTION,
    start: {
      dateTime: reservation.startAt,
      timeZone: TIME_ZONE,
    },
    end: {
      dateTime: reservation.endAt,
      timeZone: TIME_ZONE,
    },
    attendees: [{ email: reservation.customerEmail }],
    extendedProperties: {
      private: { reservationId: reservation.id },
    },
    conferenceData: {
      createRequest: {
        requestId: createMeetRequestId(reservation.id),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
}

function hasExpectedAttendee(attendees, expectedEmail) {
  return (
    Array.isArray(attendees) &&
    attendees.length === 1 &&
    normalizeEmail(attendees[0]?.email) === expectedEmail
  );
}

function validateGoogleEvent(event, reservation, eventId) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;

  const eventStart = parseTimestamp(event.start?.dateTime);
  const eventEnd = parseTimestamp(event.end?.dateTime);

  return (
    event.id === eventId &&
    event.status !== "cancelled" &&
    event.summary === EVENT_SUMMARY &&
    event.extendedProperties?.private?.reservationId === reservation.id &&
    eventStart?.getTime() === reservation.startTime &&
    eventEnd?.getTime() === reservation.endTime &&
    event.start?.timeZone === TIME_ZONE &&
    event.end?.timeZone === TIME_ZONE &&
    hasExpectedAttendee(event.attendees, reservation.customerEmail)
  );
}

function getMeetState(event) {
  const statusCode = event?.conferenceData?.createRequest?.status?.statusCode;

  if (statusCode === "pending") return { status: "pending" };
  if (statusCode === "failure") return { status: "failure" };
  if (statusCode !== "success") return { status: "invalid" };

  if (
    event.conferenceData?.conferenceSolution?.key?.type !== "hangoutsMeet" ||
    !Array.isArray(event.conferenceData?.entryPoints)
  ) {
    return { status: "invalid" };
  }

  const videoEntryPoints = event.conferenceData.entryPoints.filter(
    (entryPoint) => entryPoint?.entryPointType === "video",
  );
  if (videoEntryPoints.length !== 1) return { status: "invalid" };

  const meetUrl = parseHttpsUrl(videoEntryPoints[0].uri);
  if (
    !meetUrl ||
    meetUrl.hostname !== "meet.google.com" ||
    meetUrl.pathname === "/"
  ) {
    return { status: "invalid" };
  }

  return { status: "success", meetUrl: meetUrl.href };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reconcileExistingEvent(accessToken, reservation, eventId) {
  for (const delay of EVENT_RECONCILIATION_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    const event = await fetchGoogleEvent(accessToken, eventId);
    if (!event) continue;

    if (!validateGoogleEvent(event, reservation, eventId)) {
      return { outcome: "conflict" };
    }
    return { outcome: "found", event };
  }

  return { outcome: "not_found" };
}

async function insertOrRecoverEvent(accessToken, reservation, eventId) {
  let insertResponse;
  try {
    insertResponse = await fetch(createGoogleEventsUrl(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createGoogleEventBody(reservation, eventId)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return reconcileExistingEvent(accessToken, reservation, eventId);
  }

  if (insertResponse.status === 409) {
    return reconcileExistingEvent(accessToken, reservation, eventId);
  }
  if (!insertResponse.ok) throw new Error("Calendar event insert failed");

  const event = await readJson(insertResponse, "Invalid Calendar insert response");
  if (!validateGoogleEvent(event, reservation, eventId)) {
    return { outcome: "conflict" };
  }
  return { outcome: "found", event };
}

async function resolveMeet(accessToken, reservation, eventId, initialEvent) {
  let event = initialEvent;
  let meetState = getMeetState(event);

  if (meetState.status !== "pending") return meetState;

  for (const delay of MEET_POLL_DELAYS_MS) {
    await wait(delay);
    event = await fetchGoogleEvent(accessToken, eventId);
    if (!event || !validateGoogleEvent(event, reservation, eventId)) {
      return { status: "invalid" };
    }

    meetState = getMeetState(event);
    if (meetState.status !== "pending") return meetState;
  }

  return { status: "pending" };
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

  const configuration = getConfiguration(process.env);
  if (!configuration) {
    return sendJson(response, 500, { ok: false, error: "calendar_failed" });
  }

  let reservationRow;
  try {
    reservationRow = await getReservation(configuration, reservationId);
  } catch {
    return sendJson(response, 500, { ok: false, error: "calendar_failed" });
  }

  if (!reservationRow) {
    return sendJson(response, 404, { ok: false, error: "reservation_not_found" });
  }

  const reservation = normalizeReservation(reservationRow, reservationId);
  if (!reservation) {
    return sendJson(response, 409, {
      ok: false,
      error: "reservation_not_eligible",
    });
  }

  const eventId = createEventId(reservationId);

  try {
    const accessToken = await getGoogleAccessToken(configuration);
    const existingEvent = await fetchGoogleEvent(accessToken, eventId);
    let eventResult;

    if (existingEvent) {
      eventResult = validateGoogleEvent(existingEvent, reservation, eventId)
        ? { outcome: "found", event: existingEvent }
        : { outcome: "conflict" };
    } else {
      eventResult = await insertOrRecoverEvent(
        accessToken,
        reservation,
        eventId,
      );
    }

    if (eventResult.outcome === "conflict") {
      return sendJson(response, 409, { ok: false, error: "event_conflict" });
    }
    if (eventResult.outcome !== "found") {
      return sendJson(response, 502, { ok: false, error: "calendar_ambiguous" });
    }

    const meetState = await resolveMeet(
      accessToken,
      reservation,
      eventId,
      eventResult.event,
    );

    if (meetState.status === "pending") {
      return sendJson(response, 202, { ok: false, error: "meet_pending" });
    }
    if (meetState.status === "failure") {
      return sendJson(response, 409, {
        ok: false,
        error: "meet_recovery_required",
      });
    }
    if (meetState.status !== "success") {
      return sendJson(response, 502, { ok: false, error: "calendar_failed" });
    }

    return sendJson(response, 200, {
      ok: true,
      eventId,
      meetUrl: meetState.meetUrl,
      reservationId,
    });
  } catch {
    return sendJson(response, 502, { ok: false, error: "calendar_failed" });
  }
};
