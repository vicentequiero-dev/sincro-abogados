module.exports = function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ ok: false });
  }

  return response.status(200).json({
    ok: true,
  });
};
