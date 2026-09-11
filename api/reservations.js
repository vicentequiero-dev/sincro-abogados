const { createHmac } = require("node:crypto");
const { isIP } = require("node:net");

const TIME_ZONE = "America/Santiago";
const ALLOWED_START_TIMES = new Set(["14:00", "14:30", "15:00", "15:30", "16:00"]);
const SLOT_DURATION_MINUTES = 30;
const MINIMUM_NOTICE_HOURS = 2;
const MAXIMUM_ADVANCE_DAYS = 30;
const RESERVATION_AMOUNT = 15000;
const MINIMUM_RATE_LIMIT_SECRET_LENGTH = 32;
const MAXIMUM_RATE_LIMIT_SECRET_LENGTH = 512;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function normalizePhoneIdentity(phone) {
  const digits = phone.replace(/\D/g, "");
  if (/^569\d{8}$/.test(digits)) return digits.slice(2);
  return digits;
}

function normalizeClientIp(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.includes(",")
  ) {
    return null;
  }

  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function getClientIp(request) {
  return normalizeClientIp(request.headers?.["x-vercel-forwarded-for"]);
}

function isReasonableRateLimitSecret(value) {
  return (
    typeof value === "string" &&
    value.length >= MINIMUM_RATE_LIMIT_SECRET_LENGTH &&
    value.length <= MAXIMUM_RATE_LIMIT_SECRET_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function createIpHash(clientIp, secret) {
  return createHmac("sha256", secret).update(clientIp).digest("hex");
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

  return {
    customerName,
    customerEmail,
    customerPhone,
    customerPhoneIdentity: normalizePhoneIdentity(customerPhone),
    practiceArea,
    ...slot,
  };
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

function createReservationHoldRpcUrl(supabaseUrl) {
  const baseUrl = new URL(supabaseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
    throw new Error("Invalid Supabase URL");
  }
  return new URL(
    "/rest/v1/rpc/create_reservation_hold_limited",
    baseUrl,
  );
}

async function createLimitedHold(
  rpcUrl,
  supabaseSecretKey,
  ipHash,
  reservation,
) {
  const databaseResponse = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      apikey: supabaseSecretKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_ip_hash: ipHash,
      p_customer_name: reservation.customerName,
      p_customer_email: reservation.customerEmail,
      p_customer_phone: reservation.customerPhone,
      p_customer_phone_identity: reservation.customerPhoneIdentity,
      p_practice_area: reservation.practiceArea,
      p_start_at: reservation.startDate.toISOString(),
      p_end_at: reservation.endDate.toISOString(),
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!databaseResponse.ok) {
    throw new Error("Reservation hold RPC failed");
  }

  const rows = await databaseResponse.json();
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0]?.decision !== "string"
  ) {
    throw new Error("Invalid reservation hold RPC response");
  }

  const result = rows[0];
  if (result.decision === "created") {
    const holdExpiresAt = new Date(result.hold_expires_at);
    if (
      typeof result.reservation_id !== "string" ||
      !UUID_PATTERN.test(result.reservation_id) ||
      !Number.isFinite(holdExpiresAt.getTime())
    ) {
      throw new Error("Invalid reservation hold RPC response");
    }
    return {
      decision: result.decision,
      reservationId: result.reservation_id.toLowerCase(),
      holdExpiresAt,
    };
  }

  if (
    result.decision !== "rate_limited" &&
    result.decision !== "slot_unavailable" &&
    result.decision !== "invalid_input"
  ) {
    throw new Error("Unknown reservation hold RPC decision");
  }

  return { decision: result.decision };
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

  const clientIp = getClientIp(request);

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  const rateLimitSecret = process.env.RESERVATION_RATE_LIMIT_SECRET;

  if (
    !clientIp ||
    !googleClientId ||
    !googleClientSecret ||
    !googleRefreshToken ||
    !supabaseUrl ||
    !supabaseSecretKey ||
    !isReasonableRateLimitSecret(rateLimitSecret)
  ) {
    return sendJson(response, 500, { ok: false, error: "reservation_failed" });
  }

  const ipHash = createIpHash(clientIp, rateLimitSecret);

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

    const holdResult = await createLimitedHold(
      createReservationHoldRpcUrl(supabaseUrl),
      supabaseSecretKey,
      ipHash,
      validated,
    );

    if (holdResult.decision === "rate_limited") {
      response.setHeader("Retry-After", "900");
      return sendJson(response, 429, {
        ok: false,
        error: "rate_limited",
      });
    }

    if (holdResult.decision === "slot_unavailable") {
      return sendJson(response, 409, { ok: false, error: "slot_unavailable" });
    }

    if (holdResult.decision === "invalid_input") {
      return sendJson(response, 400, { ok: false, error: "invalid_request" });
    }

    return sendJson(response, 201, {
      ok: true,
      reservation: {
        id: holdResult.reservationId,
        status: "pending_payment",
        startAt: formatZonedDateTime(validated.startDate),
        endAt: formatZonedDateTime(validated.endDate),
        holdExpiresAt: holdResult.holdExpiresAt.toISOString(),
        amount: RESERVATION_AMOUNT,
      },
    });
  } catch {
    return sendJson(response, 500, { ok: false, error: "reservation_failed" });
  }
};
