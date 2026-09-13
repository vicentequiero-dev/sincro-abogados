const { createHash } = require("node:crypto");
const {
  processAdminReservationNotification,
} = require("../notifications/admin-reservation");

const TIME_ZONE = "America/Santiago";
const EVENT_SUMMARY = "Consulta jurídica online - SINCRO Abogados";
const EVENT_DESCRIPTION =
  "Consulta jurídica online agendada con SINCRO Abogados.";
const SLOT_DURATION_MS = 30 * 60 * 1000;
const MAX_MEET_RETRY_ATTEMPTS = 2;
const MAX_MEET_PATCH_OPERATIONS = 4;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMPORARY_GOOGLE_REASONS = new Set([
  "backendError",
  "internalError",
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
const CONFIRMATION_SUCCESS_DECISIONS = new Set([
  "confirmed",
  "already_confirmed",
]);
const CONFIRMATION_REVIEW_DECISIONS = new Set([
  "invalid_input",
  "requires_review",
  "confirmation_conflict",
  "calendar_metadata_conflict",
  "google_event_conflict",
  "identity_mismatch",
]);

class TemporaryCalendarError extends Error {}
class DefinitiveCalendarError extends Error {}

const EXECUTION_POLICIES = Object.freeze({
  full: Object.freeze({
    budgetMs: null,
    requestTimeoutMs: 10000,
    meetPollDelaysMs: Object.freeze([250, 500, 1000, 2000]),
    invalidMeetPollDelaysMs: Object.freeze([250, 500, 1000, 2000]),
    reconciliationDelaysMs: Object.freeze([0, 250, 500, 1000]),
  }),
  immediate: Object.freeze({
    budgetMs: 6500,
    requestTimeoutMs: 3000,
    meetPollDelaysMs: Object.freeze([100, 200, 400]),
    invalidMeetPollDelaysMs: Object.freeze([100, 200]),
    reconciliationDelaysMs: Object.freeze([0, 100, 200]),
  }),
});

function createExecution(mode) {
  const policy = EXECUTION_POLICIES[mode];
  if (!policy) return null;

  const deadline = policy.budgetMs === null ? null : Date.now() + policy.budgetMs;

  function remainingMs() {
    return deadline === null ? Number.POSITIVE_INFINITY : deadline - Date.now();
  }

  function assertBudget() {
    if (remainingMs() <= 0) {
      throw new TemporaryCalendarError("Calendar execution budget exhausted");
    }
  }

  function createSignal() {
    assertBudget();
    const timeoutMs = Math.max(
      1,
      Math.min(policy.requestTimeoutMs, remainingMs()),
    );
    return AbortSignal.timeout(timeoutMs);
  }

  async function pause(delayMs) {
    assertBudget();
    if (delayMs <= 0) return;
    if (delayMs >= remainingMs()) {
      throw new TemporaryCalendarError("Calendar execution budget exhausted");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    assertBudget();
  }

  return { mode, policy, assertBudget, createSignal, pause };
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
    rpcBaseUrl: new URL("/rest/v1/rpc/", supabaseUrl),
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
    !customerEmail ||
    !startDate ||
    !endDate ||
    endDate.getTime() - startDate.getTime() !== SLOT_DURATION_MS
  ) {
    return null;
  }

  return {
    id,
    status: row.status,
    customerEmail,
    startAt: row.start_at,
    endAt: row.end_at,
    startTime: startDate.getTime(),
    endTime: endDate.getTime(),
    googleEventId:
      typeof row.google_event_id === "string" ? row.google_event_id : null,
    meetUrl: typeof row.meet_url === "string" ? row.meet_url : null,
  };
}

async function readJson(response, errorClass, message) {
  try {
    return await response.json();
  } catch {
    throw new errorClass(message);
  }
}

async function getReservation(configuration, reservationId, execution) {
  const url = new URL(configuration.reservationsUrl);
  url.searchParams.set(
    "select",
    "id,status,customer_email,start_at,end_at,google_event_id,meet_url",
  );
  url.searchParams.set("id", `eq.${reservationId}`);
  url.searchParams.set("limit", "2");

  let databaseResponse;
  try {
    databaseResponse = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        apikey: configuration.supabaseSecretKey,
      },
      signal: execution.createSignal(),
    });
  } catch {
    throw new TemporaryCalendarError("Reservation lookup unavailable");
  }

  if (!databaseResponse.ok) {
    throw new TemporaryCalendarError("Reservation lookup failed");
  }

  const rows = await readJson(
    databaseResponse,
    TemporaryCalendarError,
    "Invalid reservation response",
  );
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new TemporaryCalendarError("Invalid reservation response");
  }

  return rows[0] || null;
}

function getGoogleErrorReasons(errorData) {
  if (!errorData || typeof errorData !== "object" || Array.isArray(errorData)) {
    return [];
  }

  const nestedErrors = Array.isArray(errorData.error?.errors)
    ? errorData.error.errors
    : [];
  return nestedErrors
    .map((entry) => entry?.reason)
    .filter((reason) => typeof reason === "string");
}

async function throwForGoogleHttpError(response, operation) {
  if (
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    throw new TemporaryCalendarError(`${operation} temporarily failed`);
  }

  let errorData = null;
  try {
    errorData = await response.json();
  } catch {
    // The HTTP status remains authoritative for the safe classification below.
  }

  const reasons = getGoogleErrorReasons(errorData);
  if (
    response.status === 401 ||
    reasons.some((reason) => TEMPORARY_GOOGLE_REASONS.has(reason))
  ) {
    throw new TemporaryCalendarError(`${operation} temporarily failed`);
  }

  throw new DefinitiveCalendarError(`${operation} permanently failed`);
}

async function getGoogleAccessToken(configuration, execution) {
  let tokenResponse;
  try {
    tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: configuration.googleClientId,
        client_secret: configuration.googleClientSecret,
        grant_type: "refresh_token",
        refresh_token: configuration.googleRefreshToken,
      }),
      signal: execution.createSignal(),
    });
  } catch {
    throw new TemporaryCalendarError("Token refresh unavailable");
  }

  if (!tokenResponse.ok) {
    if (
      tokenResponse.status === 408 ||
      tokenResponse.status === 429 ||
      tokenResponse.status >= 500
    ) {
      throw new TemporaryCalendarError("Token refresh temporarily failed");
    }
    throw new DefinitiveCalendarError("Token refresh permanently failed");
  }

  const tokenData = await readJson(
    tokenResponse,
    TemporaryCalendarError,
    "Invalid token response",
  );
  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new TemporaryCalendarError("Access token missing");
  }

  return tokenData.access_token;
}

function createEventId(reservationId) {
  return `sincro${reservationId.replaceAll("-", "")}`;
}

function createMeetRequestId(reservationId, retryNumber = 0) {
  const source =
    retryNumber === 0
      ? `sincro-meet-v1:${reservationId}`
      : `sincro-meet-retry-${retryNumber}:${reservationId}`;
  return createHash("sha256").update(source).digest("hex");
}

function createGoogleEventUrl(eventId, includePatchParameters = false) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
  );
  if (includePatchParameters) {
    url.searchParams.set("conferenceDataVersion", "1");
    url.searchParams.set("sendUpdates", "all");
  }
  return url;
}

function createGoogleEventsUrl() {
  const url = new URL(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  );
  url.searchParams.set("conferenceDataVersion", "1");
  url.searchParams.set("sendUpdates", "all");
  return url;
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

async function fetchGoogleEvent(accessToken, eventId, execution) {
  let googleResponse;
  try {
    googleResponse = await fetch(createGoogleEventUrl(eventId), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: execution.createSignal(),
    });
  } catch {
    throw new TemporaryCalendarError("Calendar event lookup unavailable");
  }

  if (googleResponse.status === 404) return null;
  if (!googleResponse.ok) {
    await throwForGoogleHttpError(googleResponse, "Calendar event lookup");
  }

  return readJson(
    googleResponse,
    TemporaryCalendarError,
    "Invalid Calendar event response",
  );
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

async function getBusyIntervals(accessToken, reservation, execution) {
  let freeBusyResponse;
  try {
    freeBusyResponse = await fetch(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin: new Date(reservation.startTime).toISOString(),
          timeMax: new Date(reservation.endTime).toISOString(),
          timeZone: TIME_ZONE,
          items: [{ id: "primary" }],
        }),
        signal: execution.createSignal(),
      },
    );
  } catch {
    throw new TemporaryCalendarError("FreeBusy unavailable");
  }

  if (!freeBusyResponse.ok) {
    await throwForGoogleHttpError(freeBusyResponse, "FreeBusy");
  }

  const freeBusyData = await readJson(
    freeBusyResponse,
    TemporaryCalendarError,
    "Invalid FreeBusy response",
  );
  const calendarResults = Object.values(freeBusyData.calendars || {});
  if (calendarResults.length !== 1) {
    throw new TemporaryCalendarError("Invalid FreeBusy response");
  }

  const [calendarResult] = calendarResults;
  if (!calendarResult || !Array.isArray(calendarResult.busy)) {
    throw new TemporaryCalendarError("Invalid FreeBusy calendar result");
  }

  if (Array.isArray(calendarResult.errors) && calendarResult.errors.length > 0) {
    const reasons = calendarResult.errors
      .map((entry) => entry?.reason)
      .filter((reason) => typeof reason === "string");
    if (reasons.some((reason) => TEMPORARY_GOOGLE_REASONS.has(reason))) {
      throw new TemporaryCalendarError("FreeBusy temporarily failed");
    }
    throw new DefinitiveCalendarError("FreeBusy permanently failed");
  }

  return calendarResult.busy.map((interval) => {
    const start = parseTimestamp(interval?.start);
    const end = parseTimestamp(interval?.end);
    if (!start || !end || start >= end) {
      throw new TemporaryCalendarError("Invalid FreeBusy interval");
    }
    return { start: start.getTime(), end: end.getTime() };
  });
}

async function isSlotBusy(accessToken, reservation, execution) {
  const busyIntervals = await getBusyIntervals(
    accessToken,
    reservation,
    execution,
  );
  return busyIntervals.some(
    (interval) =>
      reservation.startTime < interval.end && reservation.endTime > interval.start,
  );
}

async function reconcileExistingEvent(
  accessToken,
  reservation,
  eventId,
  execution,
) {
  for (const delay of execution.policy.reconciliationDelaysMs) {
    await execution.pause(delay);
    const event = await fetchGoogleEvent(accessToken, eventId, execution);
    if (!event) continue;
    if (!validateGoogleEvent(event, reservation, eventId)) {
      return { outcome: "conflict" };
    }
    return { outcome: "found", event };
  }

  return { outcome: "not_found" };
}

async function insertOrRecoverEvent(
  accessToken,
  reservation,
  eventId,
  execution,
) {
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
      signal: execution.createSignal(),
    });
  } catch {
    const reconciliation = await reconcileExistingEvent(
      accessToken,
      reservation,
      eventId,
      execution,
    );
    if (reconciliation.outcome === "not_found") {
      throw new TemporaryCalendarError("Calendar insert result is ambiguous");
    }
    return reconciliation;
  }

  if (insertResponse.status === 409) {
    const reconciliation = await reconcileExistingEvent(
      accessToken,
      reservation,
      eventId,
      execution,
    );
    if (reconciliation.outcome === "not_found") {
      throw new TemporaryCalendarError("Duplicate event is not yet readable");
    }
    return reconciliation;
  }

  if (!insertResponse.ok) {
    await throwForGoogleHttpError(insertResponse, "Calendar event insert");
  }

  let event;
  try {
    event = await insertResponse.json();
  } catch {
    event = null;
  }

  if (event && validateGoogleEvent(event, reservation, eventId)) {
    return { outcome: "found", event };
  }

  const reconciliation = await reconcileExistingEvent(
    accessToken,
    reservation,
    eventId,
    execution,
  );
  if (reconciliation.outcome === "not_found") {
    throw new TemporaryCalendarError("Calendar insert response is ambiguous");
  }
  return reconciliation;
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

async function observeMeet(
  accessToken,
  reservation,
  eventId,
  initialEvent,
  execution,
) {
  let event = initialEvent;
  let state = getMeetState(event);

  if (state.status === "invalid") {
    for (const delay of execution.policy.invalidMeetPollDelaysMs) {
      await execution.pause(delay);
      const refreshed = await fetchGoogleEvent(accessToken, eventId, execution);
      if (!refreshed) {
        throw new TemporaryCalendarError(
          "Calendar event is temporarily missing",
        );
      }
      if (!validateGoogleEvent(refreshed, reservation, eventId)) {
        throw new DefinitiveCalendarError("Calendar event metadata changed");
      }
      event = refreshed;
      state = getMeetState(event);
      if (state.status !== "invalid") return { state, event };
    }
  }

  if (state.status !== "pending") return { state, event };

  for (const delay of execution.policy.meetPollDelaysMs) {
    await execution.pause(delay);
    const refreshed = await fetchGoogleEvent(accessToken, eventId, execution);
    if (!refreshed) {
      throw new TemporaryCalendarError("Calendar event is temporarily missing");
    }
    if (!validateGoogleEvent(refreshed, reservation, eventId)) {
      throw new DefinitiveCalendarError("Calendar event metadata changed");
    }

    event = refreshed;
    state = getMeetState(event);
    if (state.status !== "pending") return { state, event };
  }

  return { state: { status: "pending" }, event };
}

function getMeetRetryNumber(event, reservationId) {
  const requestId = event?.conferenceData?.createRequest?.requestId;
  if (requestId === createMeetRequestId(reservationId)) return 1;

  for (let retry = 1; retry <= MAX_MEET_RETRY_ATTEMPTS; retry += 1) {
    if (requestId === createMeetRequestId(reservationId, retry)) {
      return retry + 1;
    }
  }

  return null;
}

async function patchMeetConference(
  accessToken,
  reservation,
  eventId,
  event,
  retryNumber,
  execution,
) {
  if (typeof event.etag !== "string" || !event.etag) {
    throw new DefinitiveCalendarError("Calendar event ETag missing");
  }

  const requestId = createMeetRequestId(reservation.id, retryNumber);
  let patchResponse;
  try {
    patchResponse = await fetch(createGoogleEventUrl(eventId, true), {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "If-Match": event.etag,
      },
      body: JSON.stringify({
        conferenceData: {
          createRequest: {
            requestId,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
      signal: execution.createSignal(),
    });
  } catch {
    const reconciliation = await reconcileExistingEvent(
      accessToken,
      reservation,
      eventId,
      execution,
    );
    if (reconciliation.outcome === "conflict") {
      throw new DefinitiveCalendarError("Calendar event metadata changed");
    }
    if (reconciliation.outcome !== "found") {
      throw new TemporaryCalendarError("Meet patch result is ambiguous");
    }

    const observedRequestId =
      reconciliation.event?.conferenceData?.createRequest?.requestId;
    if (observedRequestId !== requestId) {
      throw new TemporaryCalendarError("Meet patch is not yet observable");
    }
    return reconciliation.event;
  }

  if (patchResponse.status === 412) {
    const refreshed = await fetchGoogleEvent(accessToken, eventId, execution);
    if (!refreshed) {
      throw new TemporaryCalendarError("Calendar event is temporarily missing");
    }
    if (!validateGoogleEvent(refreshed, reservation, eventId)) {
      throw new DefinitiveCalendarError("Calendar event metadata changed");
    }
    return refreshed;
  }

  if (!patchResponse.ok) {
    await throwForGoogleHttpError(patchResponse, "Meet conference patch");
  }

  let patchedEvent;
  try {
    patchedEvent = await patchResponse.json();
  } catch {
    patchedEvent = null;
  }

  if (patchedEvent && validateGoogleEvent(patchedEvent, reservation, eventId)) {
    return patchedEvent;
  }

  const reconciliation = await reconcileExistingEvent(
    accessToken,
    reservation,
    eventId,
    execution,
  );
  if (reconciliation.outcome === "conflict") {
    throw new DefinitiveCalendarError("Calendar event metadata changed");
  }
  if (reconciliation.outcome !== "found") {
    throw new TemporaryCalendarError("Meet patch response is ambiguous");
  }
  return reconciliation.event;
}

async function resolveMeet(
  accessToken,
  reservation,
  eventId,
  initialEvent,
  execution,
) {
  let event = initialEvent;
  let patchOperations = 0;

  while (patchOperations <= MAX_MEET_PATCH_OPERATIONS) {
    const observation = await observeMeet(
      accessToken,
      reservation,
      eventId,
      event,
      execution,
    );
    event = observation.event;

    if (observation.state.status === "success") return observation.state;
    if (observation.state.status === "pending") return observation.state;
    if (observation.state.status === "invalid") {
      if (execution.mode === "immediate") {
        throw new TemporaryCalendarError("Meet conference data is incomplete");
      }
      throw new DefinitiveCalendarError("Invalid Meet conference data");
    }

    const retryNumber = getMeetRetryNumber(event, reservation.id);
    if (
      retryNumber === null ||
      retryNumber > MAX_MEET_RETRY_ATTEMPTS
    ) {
      throw new DefinitiveCalendarError("Meet recovery attempts exhausted");
    }
    if (patchOperations >= MAX_MEET_PATCH_OPERATIONS) {
      throw new TemporaryCalendarError("Meet recovery is still concurrent");
    }

    patchOperations += 1;
    event = await patchMeetConference(
      accessToken,
      reservation,
      eventId,
      event,
      retryNumber,
      execution,
    );
  }

  throw new TemporaryCalendarError("Meet recovery did not settle");
}

async function callReservationRpc(
  configuration,
  functionName,
  parameters,
  execution,
) {
  const rpcUrl = new URL(functionName, configuration.rpcBaseUrl);
  let databaseResponse;
  try {
    databaseResponse = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        apikey: configuration.supabaseSecretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parameters),
      signal: execution.createSignal(),
    });
  } catch {
    throw new TemporaryCalendarError("Reservation RPC unavailable");
  }

  if (!databaseResponse.ok) {
    throw new TemporaryCalendarError("Reservation RPC failed");
  }

  const rows = await readJson(
    databaseResponse,
    TemporaryCalendarError,
    "Invalid Reservation RPC response",
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0]?.decision !== "string"
  ) {
    throw new TemporaryCalendarError("Invalid Reservation RPC response");
  }

  return rows[0];
}

async function markReservationForReview(
  configuration,
  reservationId,
  execution,
) {
  return callReservationRpc(
    configuration,
    "mark_calendar_reservation_for_review",
    { p_reservation_id: reservationId },
    execution,
  );
}

async function commitCalendarConfirmation(
  configuration,
  reservationId,
  eventId,
  meetUrl,
  execution,
) {
  return callReservationRpc(
    configuration,
    "confirm_calendar_reservation",
    {
      p_reservation_id: reservationId,
      p_google_event_id: eventId,
      p_meet_url: meetUrl,
    },
    execution,
  );
}

async function handleDefinitiveFailure(
  configuration,
  reservationId,
  reservationStatus,
  execution,
) {
  if (reservationStatus !== "paid") return { outcome: "needs_review" };

  let reviewResult;
  try {
    reviewResult = await markReservationForReview(
      configuration,
      reservationId,
      execution,
    );
  } catch {
    return { outcome: "pending" };
  }

  if (
    reviewResult.decision === "marked_for_review" ||
    reviewResult.decision === "already_needs_review"
  ) {
    return { outcome: "needs_review" };
  }
  if (reviewResult.decision === "already_confirmed") {
    return { outcome: "already_confirmed" };
  }
  return { outcome: "pending" };
}

function isStoredConfirmationCoherent(reservation, eventId, meetUrl) {
  const storedMeetUrl = parseHttpsUrl(reservation.meetUrl);
  return (
    reservation.googleEventId === eventId &&
    storedMeetUrl?.hostname === "meet.google.com" &&
    storedMeetUrl.pathname !== "/" &&
    storedMeetUrl.href === meetUrl
  );
}

async function processCalendarReservationCore({
  reservationId,
  environment,
  mode = "full",
}) {
  if (typeof reservationId !== "string" || !UUID_PATTERN.test(reservationId)) {
    return { outcome: "not_eligible" };
  }

  const normalizedReservationId = reservationId.toLowerCase();
  const execution = createExecution(mode);
  if (!execution) return { outcome: "pending" };

  const configuration = getConfiguration(environment || {});
  if (!configuration) return { outcome: "pending" };

  let reservationRow;
  try {
    reservationRow = await getReservation(
      configuration,
      normalizedReservationId,
      execution,
    );
  } catch {
    return { outcome: "pending" };
  }

  if (!reservationRow) {
    return { outcome: "not_found" };
  }

  if (reservationRow.status === "paid_needs_review") {
    return { outcome: "needs_review" };
  }
  if (!new Set(["paid", "confirmed"]).has(reservationRow.status)) {
    return { outcome: "not_eligible" };
  }

  const reservation = normalizeReservation(
    reservationRow,
    normalizedReservationId,
  );
  if (!reservation) {
    return handleDefinitiveFailure(
      configuration,
      normalizedReservationId,
      reservationRow.status,
      execution,
    );
  }

  const eventId = createEventId(normalizedReservationId);

  try {
    execution.assertBudget();
    const accessToken = await getGoogleAccessToken(configuration, execution);
    let event = await fetchGoogleEvent(accessToken, eventId, execution);

    if (reservation.status === "confirmed") {
      if (!event || !validateGoogleEvent(event, reservation, eventId)) {
        throw new DefinitiveCalendarError("Confirmed event is inconsistent");
      }

      const meetState = getMeetState(event);
      if (meetState.status === "pending") return { outcome: "pending" };
      if (
        meetState.status !== "success" ||
        !isStoredConfirmationCoherent(
          reservation,
          eventId,
          meetState.meetUrl,
        )
      ) {
        throw new DefinitiveCalendarError("Confirmed Meet is inconsistent");
      }
      return { outcome: "already_confirmed" };
    }

    if (event && !validateGoogleEvent(event, reservation, eventId)) {
      throw new DefinitiveCalendarError("Existing event is incompatible");
    }

    if (!event) {
      if (await isSlotBusy(accessToken, reservation, execution)) {
        throw new DefinitiveCalendarError("Calendar slot is occupied");
      }

      const eventResult = await insertOrRecoverEvent(
        accessToken,
        reservation,
        eventId,
        execution,
      );
      if (eventResult.outcome === "conflict") {
        throw new DefinitiveCalendarError("Existing event is incompatible");
      }
      if (eventResult.outcome !== "found") {
        throw new TemporaryCalendarError("Calendar event is pending");
      }
      event = eventResult.event;
    }

    const meetState = await resolveMeet(
      accessToken,
      reservation,
      eventId,
      event,
      execution,
    );
    if (meetState.status === "pending") return { outcome: "pending" };
    if (meetState.status !== "success") {
      throw new DefinitiveCalendarError("Meet recovery failed");
    }

    const confirmation = await commitCalendarConfirmation(
      configuration,
      normalizedReservationId,
      eventId,
      meetState.meetUrl,
      execution,
    );

    if (CONFIRMATION_SUCCESS_DECISIONS.has(confirmation.decision)) {
      return { outcome: confirmation.decision };
    }

    if (CONFIRMATION_REVIEW_DECISIONS.has(confirmation.decision)) {
      return handleDefinitiveFailure(
        configuration,
        normalizedReservationId,
        confirmation.reservation_status,
        execution,
      );
    }

    if (confirmation.decision === "not_found") {
      return { outcome: "not_found" };
    }
    if (confirmation.decision === "invalid_status") {
      return { outcome: "not_eligible" };
    }
    return { outcome: "pending" };
  } catch (error) {
    if (error instanceof DefinitiveCalendarError) {
      return handleDefinitiveFailure(
        configuration,
        normalizedReservationId,
        reservation.status,
        execution,
      );
    }
    return { outcome: "pending" };
  }
}

async function processCalendarReservation(options) {
  const result = await processCalendarReservationCore(options);

  if (
    result?.outcome === "confirmed" ||
    result?.outcome === "already_confirmed"
  ) {
    try {
      await processAdminReservationNotification({
        reservationId: options.reservationId.toLowerCase(),
        environment: options.environment,
      });
    } catch {
      // Calendar confirmation remains authoritative if email delivery fails.
    }
  }

  return result;
}

module.exports = { processCalendarReservation };
