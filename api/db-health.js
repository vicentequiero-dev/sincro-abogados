module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    return response.status(500).json({
      ok: false,
      error: "Database connection failed",
    });
  }

  try {
    const endpoint = new URL("/rest/v1/reservations", supabaseUrl);
    endpoint.searchParams.set("select", "*");
    endpoint.searchParams.set("limit", "1");

    if (endpoint.protocol !== "https:") {
      throw new Error("Invalid database URL");
    }

    const databaseResponse = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        apikey: supabaseSecretKey,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!databaseResponse.ok) {
      throw new Error("Database request failed");
    }

    return response.status(200).json({
      ok: true,
      database: "connected",
    });
  } catch {
    return response.status(500).json({
      ok: false,
      error: "Database connection failed",
    });
  }
};
