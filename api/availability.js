const TIME_ZONE = "America/Santiago";
const SLOT_START_TIMES = ["14:00", "14:30", "15:00", "15:30", "16:00"];
const SLOT_DURATION_MINUTES = 30;
const MINIMUM_NOTICE_HOURS = 2;
const MAXIMUM_ADVANCE_DAYS = 30;

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

function zonedDateTimeToDate(dateString, timeString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute] = timeString.split(":").map(Number);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = targetAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const adjusted = targetAsUtc - getTimeZoneOffsetMilliseconds(new Date(instant));
    if (adjusted === instant) break;
    instant = adjusted;
  }

  const result = new Date(instant);
  const parts = getZonedParts(result);
  const matchesRequestedTime =
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === hour &&
    parts.minute === minute;

  if (!matchesRequestedTime) {
    throw new Error("Invalid local time");
  }

  return result;
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

function isValidDateString(dateString) {
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return false;
  }

  const [year, month, day] = dateString.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isWeekday(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function createSlots(dateString) {
  return SLOT_START_TIMES.map((time) => {
    const startDate = zonedDateTimeToDate(dateString, time);
    const endDate = new Date(startDate.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

    return {
      startDate,
      endDate,
      start: formatZonedDateTime(startDate),
      end: formatZonedDateTime(endDate),
    };
  });
}

function overlapsBusyInterval(slot, busyInterval) {
  return slot.startDate < busyInterval.end && slot.endDate > busyInterval.start;
}

async function getAccessToken(clientId, clientSecret, refreshToken) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
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

async function getBusyIntervals(accessToken, queryStart, queryEnd) {
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
        timeMin: queryStart.toISOString(),
        timeMax: queryEnd.toISOString(),
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

  return calendarResult.busy.map((interval) => {
    const start = new Date(interval.start);
    const end = new Date(interval.end);

    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      throw new Error("Invalid busy interval");
    }

    return { start, end };
  });
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, { ok: false, error: "Method not allowed" });
  }

  const requestedDate = request.query?.date;
  const now = new Date(Date.now());
  const today = getDateInTimeZone(now);

  if (
    !isValidDateString(requestedDate) ||
    requestedDate < today ||
    requestedDate > addCalendarDays(today, MAXIMUM_ADVANCE_DAYS) ||
    !isWeekday(requestedDate)
  ) {
    return sendJson(response, 400, { ok: false, error: "Invalid date" });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return sendJson(response, 500, { ok: false, error: "Availability service failed" });
  }

  try {
    const slots = createSlots(requestedDate);
    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    const busyIntervals = await getBusyIntervals(
      accessToken,
      slots[0].startDate,
      slots[slots.length - 1].endDate,
    );
    const minimumStartTime = now.getTime() + MINIMUM_NOTICE_HOURS * 60 * 60 * 1000;

    const availableSlots = slots
      .filter(
        (slot) =>
          slot.startDate.getTime() >= minimumStartTime &&
          !busyIntervals.some((busyInterval) => overlapsBusyInterval(slot, busyInterval)),
      )
      .map(({ start, end }) => ({ start, end }));

    return sendJson(response, 200, {
      ok: true,
      date: requestedDate,
      timezone: TIME_ZONE,
      slots: availableSlots,
    });
  } catch {
    return sendJson(response, 500, { ok: false, error: "Availability service failed" });
  }
};
