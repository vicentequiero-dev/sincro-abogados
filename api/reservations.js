const TIME_ZONE = "America/Santiago";
const ALLOWED_START_TIMES = new Set(["14:00", "14:30", "15:00", "15:30", "16:00"]);
const SLOT_DURATION_MINUTES = 30;
const MINIMUM_NOTICE_HOURS = 2;
const MAXIMUM_ADVANCE_DAYS = 30;
const HOLD_DURATION_MINUTES = 10;
const RESERVATION_AMOUNT = 15000;
const OVERLAP_CONSTRAINT = "reservations_no_active_overlap";

const zonedDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

function getZonedParts(date) {
  return Object.fromEntries(
    zonedDateTimeFormatter
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
}

function getTimeZoneOffsetMilliseconds(date) {
  const parts = getZonedParts(date);
  const instantWithoutMilliseconds = Math.floor(date.getTime() / 1000) * 1000;

  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - instantWithoutMilliseconds
  );
}

function formatZonedDateTime(date) {
  const parts = getZonedParts(date);
  const offsetMinutes = Math.round(getTimeZoneOffsetMilliseconds(date) / 60000);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainingMinutes = absoluteOffsetMinutes % 60;
  const pad = (value) => String(value).padStart(2, "0");

  return (
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` +
    `${offsetSign}${pad(offsetHours)}:${pad(offsetRemainingMinutes)}`
  );
}

function getDateInTimeZone(date) {
  const parts = getZonedParts(date);
  const pad = (value) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function addCalendarDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value) => String(value).padStart(2, "0");
  return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`;
}

function isWeekday(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
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

function normalizeText(value, minimumLength, maximumLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length < minimumLength ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizeEmail(value) {
  const email = normalizeText(value, 3, 254)?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizePhone(value) {
  const phone = normalizeText(value, 7, 30);
  if (!phone || !/^[+0-9().\s-]+$/.test(phone)) return null;
  const digitCount = (phone.match(/\d/g) || []).length;
  return digitCount >= 7 ? phone : null;
}

function parseStartAt(value, now) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/.test(value)
  ) {
    return null;
  }

  const startDate = new Date(value);
  if (!Number.isFinite(startDate.getTime()) || formatZonedDateTime(startDate) !== value) {
    return null;
  }

  const parts = getZonedParts(startDate);
  const localDate = getDateInTimeZone(startDate);
  const localTime = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  const today = getDateInTimeZone(now);

  if (
    !ALLOWED_START_TIMES.has(localTime) ||
    parts.second !== 0 ||
    !isWeekday(localDate) ||
    localDate < today ||
    localDate > addCalendarDays(today, MAXIMUM_ADVANCE_DAYS) ||
    startDate.getTime() < now.getTime() + MINIMUM_NOTICE_HOURS * 60 * 60 * 1000
  ) {
    return null;
  }

  return {
    startDate,
    endDate: new Date(startDate.getTime() + SLOT_DURATION_MINUTES * 60 * 1000),
  };
}

function validatePayload(body, now) {
  const payload = parseRequestBody(body);
  if (!payload) return null;

  const customerName = normalizeText(payload.customerName, 2, 120);
  const customerEmail = normalizeEmail(payload.customerEmail);
  const customerPhone = normalizePhone(payload.customerPhone);
  const practiceArea = normalizeText(payload.practiceArea, 2, 120);
  const slot = parseStartAt(payload.startAt, now);

  if (!customerName || !customerEmail || !customerPhone || !practiceArea || !slot) {
    return null;
  }

  return { customerName, customerEmail, customerPhone, practiceArea, ...slot };
}

async function getGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!tokenResponse.ok) throw new Error("Token refresh failed");

  const tokenData = await tokenResponse.json();
  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new Error("Access token missing");
  }

  return tokenData.access_token;
}

async function isSlotBusyInGoogle(accessToken, startDate, endDate) {
  const freeBusyResponse = await fetch(
    "https://www.googleapis.com/calendar/v3/freeBusy",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        timeZone: TIME_ZONE,
        items: [{ id: "primary" }],
      }),
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!freeBusyResponse.ok) throw new Error("FreeBusy request failed");

  const freeBusyData = await freeBusyResponse.json();
  const calendarResults = Object.values(freeBusyData.calendars || {});
  if (calendarResults.length !== 1) throw new Error("Calendar result missing");

  const [calendarResult] = calendarResults;
  if (
    !calendarResult ||
    !Array.isArray(calendarResult.busy) ||
    (Array.isArray(calendarResult.errors) && calendarResult.errors.length > 0)
  ) {
    throw new Error("Invalid calendar result");
  }

  return calendarResult.busy.some((interval) => {
    const busyStart = new Date(interval.start);
    const busyEnd = new Date(interval.end);
    if (
      !Number.isFinite(busyStart.getTime()) ||
      !Number.isFinite(busyEnd.getTime()) ||
      busyStart >= busyEnd
    ) {
      throw new Error("Invalid busy interval");
    }
    return startDate < busyEnd && endDate > busyStart;
  });
}

function createReservationsUrl(supabaseUrl) {
  const baseUrl = new URL(supabaseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
    throw new Error("Invalid Supabase URL");
  }
  return new URL("/rest/v1/reservations", baseUrl);
}

async function expirePendingHolds(reservationsUrl, supabaseSecretKey, now) {
  const expirationUrl = new URL(reservationsUrl);
  expirationUrl.searchParams.set("status", "eq.pending_payment");
  expirationUrl.searchParams.set("hold_expires_at", `lte.${now.toISOString()}`);

  const expirationResponse = await fetch(expirationUrl, {
    method: "PATCH",
    headers: {
      apikey: supabaseSecretKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      status: "expired",
      updated_at: now.toISOString(),
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!expirationResponse.ok) throw new Error("Hold expiration failed");
}

async function readErrorResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isOverlapConstraintViolation(response, errorData) {
  if (response.status !== 409 || errorData?.code !== "23P01") return false;

  return [errorData.constraint, errorData.message, errorData.details, errorData.hint]
    .filter((value) => typeof value === "string")
    .some((value) => value.includes(OVERLAP_CONSTRAINT));
}

async function insertHold(reservationsUrl, supabaseSecretKey, reservation) {
  const insertUrl = new URL(reservationsUrl);
  insertUrl.searchParams.set("select", "id");

  const insertResponse = await fetch(insertUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      apikey: supabaseSecretKey,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(reservation),
    signal: AbortSignal.timeout(10000),
  });

  if (!insertResponse.ok) {
    const errorData = await readErrorResponse(insertResponse);
    if (isOverlapConstraintViolation(insertResponse, errorData)) {
      return { conflict: true };
    }
    throw new Error("Reservation insert failed");
  }

  const insertedRows = await insertResponse.json();
  if (
    !Array.isArray(insertedRows) ||
    insertedRows.length !== 1 ||
    typeof insertedRows[0]?.id !== "string"
  ) {
    throw new Error("Invalid insert response");
  }

  return { conflict: false, id: insertedRows[0].id };
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { ok: false, error: "Method not allowed" });
  }

  const requestTime = new Date(Date.now());
  const validated = validatePayload(request.body, requestTime);
  if (!validated) {
    return sendJson(response, 400, { ok: false, error: "invalid_request" });
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (
    !googleClientId ||
    !googleClientSecret ||
    !googleRefreshToken ||
    !supabaseUrl ||
    !supabaseSecretKey
  ) {
    return sendJson(response, 500, { ok: false, error: "reservation_failed" });
  }

  try {
    const googleAccessToken = await getGoogleAccessToken(
      googleClientId,
      googleClientSecret,
      googleRefreshToken,
    );
    const isBusy = await isSlotBusyInGoogle(
      googleAccessToken,
      validated.startDate,
      validated.endDate,
    );

    if (isBusy) {
      return sendJson(response, 409, { ok: false, error: "slot_unavailable" });
    }

    const reservationsUrl = createReservationsUrl(supabaseUrl);
    let databaseNow = new Date(Date.now());
    await expirePendingHolds(reservationsUrl, supabaseSecretKey, databaseNow);

    const holdExpiresAt = new Date(
      databaseNow.getTime() + HOLD_DURATION_MINUTES * 60 * 1000,
    );
    const reservationToInsert = {
      customer_name: validated.customerName,
      customer_email: validated.customerEmail,
      customer_phone: validated.customerPhone,
      practice_area: validated.practiceArea,
      start_at: validated.startDate.toISOString(),
      end_at: validated.endDate.toISOString(),
      status: "pending_payment",
      hold_expires_at: holdExpiresAt.toISOString(),
      amount: RESERVATION_AMOUNT,
    };

    let insertResult = await insertHold(
      reservationsUrl,
      supabaseSecretKey,
      reservationToInsert,
    );

    if (insertResult.conflict) {
      databaseNow = new Date(Date.now());
      await expirePendingHolds(reservationsUrl, supabaseSecretKey, databaseNow);
      insertResult = await insertHold(
        reservationsUrl,
        supabaseSecretKey,
        reservationToInsert,
      );
    }

    if (insertResult.conflict) {
      return sendJson(response, 409, { ok: false, error: "slot_unavailable" });
    }

    return sendJson(response, 201, {
      ok: true,
      reservation: {
        id: insertResult.id,
        status: "pending_payment",
        startAt: formatZonedDateTime(validated.startDate),
        endAt: formatZonedDateTime(validated.endDate),
        holdExpiresAt: holdExpiresAt.toISOString(),
        amount: RESERVATION_AMOUNT,
      },
    });
  } catch {
    return sendJson(response, 500, { ok: false, error: "reservation_failed" });
  }
};
