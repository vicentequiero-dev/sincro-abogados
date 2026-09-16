const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const TIME_ZONE = "America/Santiago";
const SUBJECT = "Nueva consulta confirmada - SINCRO Abogados";
const RPC_TIMEOUT_MS = 5000;
const RESEND_TIMEOUT_MS = 8000;
const SLOT_DURATION_MS = 30 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,255}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDER_PATTERN =
  /^(?:[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+|[^<>]{1,200} <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>)$/;
const OFFICIAL_RESEND_ERRORS = new Map([
  ["invalid_idempotency_key", new Set([400])],
  ["validation_error", new Set([400, 403])],
  ["missing_api_key", new Set([401])],
  ["restricted_api_key", new Set([401, 403])],
  ["email_above_quota", new Set([403])],
  ["invalid_permission", new Set([403])],
  ["invalid_api_key", new Set([403])],
  ["suspended_api_key", new Set([403])],
  ["not_found", new Set([404])],
  ["method_not_allowed", new Set([405])],
  ["invalid_idempotent_request", new Set([409])],
  ["concurrent_idempotent_requests", new Set([409])],
  ["resource_locked", new Set([409])],
  ["invalid_attachment", new Set([422])],
  ["invalid_from_address", new Set([422])],
  ["invalid_access", new Set([422])],
  ["invalid_parameter", new Set([422])],
  ["invalid_region", new Set([422])],
  ["missing_required_field", new Set([422])],
  ["missing_required_parameter", new Set([422])],
  ["monthly_quota_exceeded", new Set([429])],
  ["daily_quota_exceeded", new Set([429])],
  ["rate_limit_exceeded", new Set([429])],
  ["security_error", new Set([451])],
  ["application_error", new Set([500])],
  ["internal_server_error", new Set([500])],
  ["service_unavailable", new Set([503])],
]);

function parseHttpsUrl(value) {
  if (typeof value !== "string" || !value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !EMAIL_PATTERN.test(email)
  ) {
    return null;
  }
  return email;
}

function normalizeSender(value) {
  if (typeof value !== "string") return null;
  const sender = value.trim();
  if (
    sender.length < 3 ||
    sender.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(sender) ||
    !SENDER_PATTERN.test(sender)
  ) {
    return null;
  }
  return sender;
}

function isReasonableSecret(value) {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 512 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function getConfiguration(environment) {
  if (!environment || typeof environment !== "object") return null;

  const supabaseUrl = parseHttpsUrl(environment.SUPABASE_URL);
  const recipient = normalizeEmail(environment.ADMIN_NOTIFICATION_TO);
  const sender = normalizeSender(environment.ADMIN_NOTIFICATION_FROM);

  if (
    !supabaseUrl ||
    !isReasonableSecret(environment.SUPABASE_SECRET_KEY) ||
    !isReasonableSecret(environment.RESEND_API_KEY) ||
    !recipient ||
    !sender
  ) {
    return null;
  }

  return {
    rpcBaseUrl: new URL("/rest/v1/rpc/", supabaseUrl),
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    resendApiKey: environment.RESEND_API_KEY,
    recipient,
    sender,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function callRpc(configuration, functionName, parameters) {
  const url = new URL(functionName, configuration.rpcBaseUrl);
  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        apikey: configuration.supabaseSecretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parameters),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, data: null };
  }

  if (!response.ok) return { ok: false, data: null };
  const data = await readJson(response);
  return data === null
    ? { ok: false, data: null }
    : { ok: true, data };
}

async function claimNotification(configuration, reservationId) {
  const result = await callRpc(
    configuration,
    "claim_admin_reservation_notification",
    {
      p_reservation_id: reservationId,
      p_recipient: configuration.recipient,
      p_sender: configuration.sender,
    },
  );

  if (
    !result.ok ||
    !Array.isArray(result.data) ||
    result.data.length !== 1 ||
    !result.data[0] ||
    typeof result.data[0].decision !== "string"
  ) {
    return null;
  }

  return result.data[0];
}

async function runStateRpc(
  configuration,
  functionName,
  reservationId,
  attemptId,
  extraParameters = {},
) {
  const result = await callRpc(configuration, functionName, {
    p_reservation_id: reservationId,
    p_attempt_id: attemptId,
    ...extraParameters,
  });

  return result.ok && typeof result.data === "string" ? result.data : null;
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

function normalizeMeetUrl(value) {
  const url = parseHttpsUrl(value);
  if (
    !url ||
    url.hostname !== "meet.google.com" ||
    url.pathname === "/" ||
    value.length > 2048
  ) {
    return null;
  }
  return url.href;
}

function normalizeClaimSnapshot(row, reservationId, configuration) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;

  const claimedReservationId =
    typeof row.reservation_id === "string" &&
    UUID_PATTERN.test(row.reservation_id)
      ? row.reservation_id.toLowerCase()
      : null;
  const attemptId =
    typeof row.attempt_id === "string" && UUID_PATTERN.test(row.attempt_id)
      ? row.attempt_id.toLowerCase()
      : null;
  const expectedIdempotencyKey =
    `sincro-admin-confirmed/${reservationId}`;
  const customerName = normalizeText(row.customer_name, 2, 120);
  const customerEmail = normalizeEmail(row.customer_email);
  const customerPhone = normalizeText(row.customer_phone, 7, 30);
  const practiceArea = normalizeText(row.practice_area, 2, 120);
  const startDate = parseTimestamp(row.start_at);
  const endDate = parseTimestamp(row.end_at);
  const meetUrl = normalizeMeetUrl(row.meet_url);

  if (
    claimedReservationId !== reservationId ||
    !attemptId ||
    row.idempotency_key !== expectedIdempotencyKey ||
    row.idempotency_key.length > 256 ||
    row.recipient !== configuration.recipient ||
    row.sender !== configuration.sender ||
    !customerName ||
    !customerEmail ||
    !customerPhone ||
    !practiceArea ||
    !startDate ||
    !endDate ||
    endDate.getTime() - startDate.getTime() !== SLOT_DURATION_MS ||
    !meetUrl
  ) {
    return null;
  }

  return {
    reservationId,
    attemptId,
    idempotencyKey: row.idempotency_key,
    recipient: row.recipient,
    sender: row.sender,
    customerName,
    customerEmail,
    customerPhone,
    practiceArea,
    startDate,
    endDate,
    meetUrl,
  };
}

function getSantiagoParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [
      part.type,
      part.value,
    ]),
  );

  if (
    !/^\d{4}$/.test(values.year) ||
    !/^\d{2}$/.test(values.month) ||
    !/^\d{2}$/.test(values.day) ||
    !/^\d{2}$/.test(values.hour) ||
    !/^\d{2}$/.test(values.minute)
  ) {
    return null;
  }

  return values;
}

function formatSchedule(startDate, endDate) {
  const start = getSantiagoParts(startDate);
  const end = getSantiagoParts(endDate);
  if (!start || !end) return null;

  const year = Number(start.year);
  const month = Number(start.month);
  const day = Number(start.day);
  const weekDays = [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
  ];
  const months = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  const weekDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const durationMinutes = Math.round(
    (endDate.getTime() - startDate.getTime()) / 60000,
  );

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    durationMinutes !== 30
  ) {
    return null;
  }

  return {
    date: `${weekDays[weekDay]}, ${day} de ${months[month - 1]} de ${year}`,
    time: `${start.hour}:${start.minute}`,
    duration: `${durationMinutes} minutos`,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildEmail(snapshot) {
  const schedule = formatSchedule(snapshot.startDate, snapshot.endDate);
  if (!schedule) return null;

  const fields = [
    ["Nombre", snapshot.customerName],
    ["Correo", snapshot.customerEmail],
    ["Teléfono", snapshot.customerPhone],
    ["Área jurídica", snapshot.practiceArea],
    ["Fecha", schedule.date],
    ["Hora", `${schedule.time} (${TIME_ZONE})`],
    ["Duración", schedule.duration],
    ["Google Meet", snapshot.meetUrl],
  ];
  const text = [
    "Nueva consulta confirmada",
    "",
    ...fields.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
  const rows = fields
    .map(([label, value]) => {
      const safeLabel = escapeHtml(label);
      const safeValue = escapeHtml(value);
      if (label === "Google Meet") {
        return `<tr><th scope="row">${safeLabel}</th><td><a href="${safeValue}">Abrir reunión</a></td></tr>`;
      }
      return `<tr><th scope="row">${safeLabel}</th><td>${safeValue}</td></tr>`;
    })
    .join("");
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(SUBJECT)}</title></head><body><main><h1>Nueva consulta confirmada</h1><table><tbody>${rows}</tbody></table></main></body></html>`;

  return {
    from: snapshot.sender,
    to: [snapshot.recipient],
    subject: SUBJECT,
    text,
    html,
  };
}

function parseOfficialResendError(value, httpStatus) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.name !== "string" ||
    typeof value.message !== "string" ||
    !value.message.trim() ||
    value.message.length > 2000 ||
    !Number.isInteger(value.statusCode) ||
    value.statusCode !== httpStatus
  ) {
    return null;
  }

  const allowedStatuses = OFFICIAL_RESEND_ERRORS.get(value.name);
  return allowedStatuses?.has(httpStatus) ? value.name : null;
}

function classifyResendError(response, errorData) {
  const errorName = parseOfficialResendError(errorData, response.status);
  if (!errorName) return "ambiguous";
  if (errorName === "invalid_idempotent_request") return "manual_review";
  if (
    errorName === "concurrent_idempotent_requests" ||
    errorName === "resource_locked"
  ) {
    return "ambiguous";
  }
  if (response.status >= 500) return "ambiguous";
  return "failed";
}

async function markAmbiguous(configuration, snapshot) {
  const decision = await runStateRpc(
    configuration,
    "mark_admin_reservation_notification_ambiguous",
    snapshot.reservationId,
    snapshot.attemptId,
  );
  return decision === "already_sent" ? "already_sent" : "pending";
}

async function markFailed(configuration, snapshot) {
  const decision = await runStateRpc(
    configuration,
    "fail_admin_reservation_notification",
    snapshot.reservationId,
    snapshot.attemptId,
  );
  if (decision === "already_sent") return "already_sent";
  if (decision === "manual_review") return "manual_review";
  return "pending";
}

async function markForReview(configuration, snapshot) {
  const decision = await runStateRpc(
    configuration,
    "mark_admin_reservation_notification_for_review",
    snapshot.reservationId,
    snapshot.attemptId,
  );
  if (decision === "manual_review" || decision === "already_manual_review") {
    return "manual_review";
  }
  if (decision === "already_sent") return "already_sent";
  return "pending";
}

async function completeNotification(configuration, snapshot, providerMessageId) {
  const decision = await runStateRpc(
    configuration,
    "complete_admin_reservation_notification",
    snapshot.reservationId,
    snapshot.attemptId,
    { p_provider_message_id: providerMessageId },
  );

  if (decision === "sent") return "sent";
  if (decision === "already_sent") return "already_sent";
  if (
    decision === "provider_message_conflict" ||
    decision === "already_sent_different_result"
  ) {
    return markForReview(configuration, snapshot);
  }
  return markAmbiguous(configuration, snapshot);
}

async function sendWithResend(configuration, snapshot, email) {
  let response;
  try {
    response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": snapshot.idempotencyKey,
      },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch {
    return markAmbiguous(configuration, snapshot);
  }

  const data = await readJson(response);
  if (response.ok) {
    const providerMessageId =
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof data.id === "string" &&
      data.id === data.id.trim() &&
      PROVIDER_ID_PATTERN.test(data.id)
        ? data.id
        : null;
    if (!providerMessageId) return markAmbiguous(configuration, snapshot);
    return completeNotification(configuration, snapshot, providerMessageId);
  }

  const classification = classifyResendError(response, data);
  if (classification === "manual_review") {
    return markForReview(configuration, snapshot);
  }
  if (classification === "failed") return markFailed(configuration, snapshot);
  return markAmbiguous(configuration, snapshot);
}

async function processAdminReservationNotification({
  reservationId,
  environment,
}) {
  if (typeof reservationId !== "string" || !UUID_PATTERN.test(reservationId)) {
    return { outcome: "not_eligible" };
  }

  const normalizedReservationId = reservationId.toLowerCase();
  const configuration = getConfiguration(environment);
  if (!configuration) return { outcome: "pending" };

  const claim = await claimNotification(configuration, normalizedReservationId);
  if (!claim) return { outcome: "pending" };

  if (claim.decision === "already_sent") {
    return { outcome: "already_sent" };
  }
  if (claim.decision === "in_progress" || claim.decision === "retry_later") {
    return { outcome: "pending" };
  }
  if (claim.decision === "manual_review") {
    return { outcome: "manual_review" };
  }
  if (
    claim.decision === "recipient_mismatch" ||
    claim.decision === "sender_mismatch"
  ) {
    return { outcome: "manual_review" };
  }
  if (claim.decision === "invalid_input") return { outcome: "pending" };
  if (claim.decision === "not_found") return { outcome: "not_found" };
  if (claim.decision === "not_eligible") {
    return { outcome: "not_eligible" };
  }
  if (claim.decision !== "send") return { outcome: "pending" };

  const snapshot = normalizeClaimSnapshot(
    claim,
    normalizedReservationId,
    configuration,
  );
  if (!snapshot) {
    const attemptId =
      typeof claim.attempt_id === "string" && UUID_PATTERN.test(claim.attempt_id)
        ? claim.attempt_id.toLowerCase()
        : null;
    if (attemptId) {
      await runStateRpc(
        configuration,
        "mark_admin_reservation_notification_for_review",
        normalizedReservationId,
        attemptId,
      );
    }
    return { outcome: "manual_review" };
  }

  const email = buildEmail(snapshot);
  if (!email) return { outcome: await markForReview(configuration, snapshot) };

  const outcome = await sendWithResend(configuration, snapshot, email);
  return { outcome };
}

module.exports = { processAdminReservationNotification };
