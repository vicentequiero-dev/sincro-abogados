function sendJson(response, statusCode, body) {
  response.setHeader("Cache-Control", "no-store");
  return response.status(statusCode).json(body);
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendJson(response, 405, {
      ok: false,
      error: "Method not allowed",
    });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return sendJson(response, 500, {
      ok: false,
      error: "Google Calendar connection failed",
    });
  }

  try {
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

    if (!tokenResponse.ok) {
      throw new Error("Token refresh failed");
    }

    const tokenData = await tokenResponse.json();
    if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
      throw new Error("Access token missing");
    }

    const calendarUrl = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    calendarUrl.searchParams.set("fields", "kind");
    calendarUrl.searchParams.set("maxResults", "1");

    const calendarResponse = await fetch(calendarUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokenData.access_token}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    tokenData.access_token = undefined;

    if (!calendarResponse.ok) {
      throw new Error("Calendar request failed");
    }

    return sendJson(response, 200, {
      ok: true,
      googleCalendar: "connected",
    });
  } catch {
    return sendJson(response, 500, {
      ok: false,
      error: "Google Calendar connection failed",
    });
  }
};
