module.exports = function handler(request, response) {
  return response.status(200).json({
    ok: true,
    service: "sincro-booking",
  });
};
