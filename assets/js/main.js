const BOOKING_TIME_ZONE = 'America/Santiago';
const BOOKING_MAX_ADVANCE_DAYS = 30;
const RESERVATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_RETRY_CODES = new Set([
  'payment_creation_failed',
  'payment_in_progress',
]);
const PAYMENT_RESERVATION_ENDED_CODES = new Set([
  'reservation_expired',
  'reservation_unavailable',
]);
const PAYMENT_AMBIGUOUS_CODES = new Set([
  'payment_ambiguous',
  'payment_creation_ambiguous',
  'payment_completion_failed',
]);

class BookingApiError extends Error {
  constructor(status, code, retryAfter = null) {
    super('Booking API request failed');
    this.name = 'BookingApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function getSantiagoDateString(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: BOOKING_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  const pad = value => String(value).padStart(2, '0');
  return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`;
}

function isWeekend(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }
  const weekday = date.getUTCDay();
  return weekday === 0 || weekday === 6;
}

function getSafeRetryAfter(response) {
  const value = response.headers?.get?.('Retry-After');
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 86400
    ? seconds
    : null;
}

async function readSafeJson(response) {
  try {
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function normalizeSlot(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string'
  ) {
    return null;
  }
  const start = new Date(value.start);
  const end = new Date(value.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    return null;
  }
  return Object.freeze({ start: value.start, end: value.end });
}

async function fetchAvailability(date, signal, fetchImplementation = fetch) {
  const response = await fetchImplementation(
    `/api/availability?date=${encodeURIComponent(date)}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    },
  );
  const body = await readSafeJson(response);
  if (!response.ok) throw new BookingApiError(response.status, body?.error);
  if (body?.ok !== true || body.date !== date || !Array.isArray(body.slots)) {
    throw new BookingApiError(502, 'invalid_response');
  }
  const slots = body.slots.map(normalizeSlot);
  if (slots.some(slot => slot === null)) {
    throw new BookingApiError(502, 'invalid_response');
  }
  return slots;
}

async function createReservation(payload, fetchImplementation = fetch) {
  const response = await fetchImplementation('/api/reservations', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await readSafeJson(response);
  if (!response.ok) {
    throw new BookingApiError(response.status, body?.error, getSafeRetryAfter(response));
  }
  const reservationId = body?.reservation?.id;
  if (body?.ok !== true || !RESERVATION_ID_PATTERN.test(reservationId || '')) {
    throw new BookingApiError(502, 'invalid_response');
  }
  return reservationId.toLowerCase();
}

function validateCheckoutUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function createPayment(reservationId, fetchImplementation = fetch) {
  const response = await fetchImplementation('/api/flow/create-payment', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ reservationId }),
  });
  const body = await readSafeJson(response);
  if (!response.ok) throw new BookingApiError(response.status, body?.error);
  const checkoutUrl = validateCheckoutUrl(body?.checkoutUrl);
  if (body?.ok !== true || body.reservationId !== reservationId || !checkoutUrl) {
    throw new BookingApiError(502, 'invalid_response');
  }
  return checkoutUrl;
}

function acquireSubmissionLock(state) {
  if (state.submissionInProgress) return false;
  state.submissionInProgress = true;
  return true;
}

function classifyPaymentStartFailure(error) {
  if (!(error instanceof BookingApiError)) return 'retry';
  if (PAYMENT_RESERVATION_ENDED_CODES.has(error.code)) return 'reservation_ended';
  if (PAYMENT_AMBIGUOUS_CODES.has(error.code)) return 'ambiguous';
  if (PAYMENT_RETRY_CODES.has(error.code)) return 'retry';
  if (error.status === 500 || error.status === 502) return 'retry';
  return 'ambiguous';
}

function applyPaymentFailureState(state, classification) {
  state.submissionInProgress = false;
  state.paymentRetryAvailable = classification === 'retry';
  if (classification === 'reservation_ended') {
    state.reservationId = null;
    state.reservationFingerprint = null;
  }
}

function initializeMobileMenu() {
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const mobileMenu = document.getElementById('mobile-menu');
  const mobileLinks = document.querySelectorAll('.mobile-link');
  if (!mobileMenuBtn || !mobileMenu) return;

  mobileMenuBtn.addEventListener('click', () => mobileMenu.classList.toggle('hidden'));
  mobileLinks.forEach(link => {
    link.addEventListener('click', () => mobileMenu.classList.add('hidden'));
  });
}

function initializeBooking() {
  const form = document.getElementById('booking-form');
  const bookingSection = document.getElementById('reserva');
  const bookingTitle = document.getElementById('booking-title');
  const dateInput = document.getElementById('booking-date');
  const scheduleFields = document.getElementById('booking-schedule-fields');
  const availabilityStatus = document.getElementById('availability-status');
  const slotsContainer = document.getElementById('booking-slots');
  const customerDetails = document.getElementById('customer-details');
  const nameInput = document.getElementById('customer-name');
  const emailInput = document.getElementById('customer-email');
  const phoneInput = document.getElementById('customer-phone');
  const practiceAreaInput = document.getElementById('practice-area');
  const bookingMessage = document.getElementById('booking-message');
  const submitButton = document.getElementById('booking-submit');
  const retryButton = document.getElementById('booking-payment-retry');
  if (
    !form || !bookingSection || !bookingTitle || !dateInput || !scheduleFields ||
    !availabilityStatus || !slotsContainer || !customerDetails || !nameInput ||
    !emailInput || !phoneInput || !practiceAreaInput || !bookingMessage ||
    !submitButton || !retryButton
  ) return;

  const state = {
    availabilityController: null,
    selectedSlot: null,
    submissionInProgress: false,
    reservationId: null,
    reservationFingerprint: null,
    paymentRetryAvailable: false,
  };
  const defaultSubmitText = submitButton.textContent.trim();
  const dateMinimum = getSantiagoDateString();
  const dateMaximum = addCalendarDays(dateMinimum, BOOKING_MAX_ADVANCE_DAYS);
  dateInput.min = dateMinimum;
  dateInput.max = dateMaximum;

  function setAvailabilityState(kind, message) {
    availabilityStatus.dataset.state = kind;
    availabilityStatus.textContent = message;
  }

  function setBookingMessage(kind, message, focus = false) {
    bookingMessage.dataset.state = kind;
    bookingMessage.textContent = message;
    if (focus && message) bookingMessage.focus({ preventScroll: true });
  }

  function getSlotInputs() {
    return slotsContainer.querySelectorAll('input[type="radio"]');
  }

  function applyControlState() {
    const lockedForPayment = state.reservationId !== null;
    dateInput.disabled = state.submissionInProgress || lockedForPayment;
    scheduleFields.disabled = state.submissionInProgress || lockedForPayment;
    customerDetails.disabled = state.submissionInProgress || lockedForPayment || !state.selectedSlot;
    getSlotInputs().forEach(input => {
      input.disabled = state.submissionInProgress || lockedForPayment;
    });
    submitButton.hidden = lockedForPayment;
    submitButton.disabled = state.submissionInProgress || lockedForPayment || !state.selectedSlot;
    retryButton.hidden = !state.paymentRetryAvailable;
    retryButton.disabled = state.submissionInProgress;
    form.setAttribute('aria-busy', String(state.submissionInProgress));
  }

  function setSubmitting(isSubmitting, buttonText = defaultSubmitText) {
    state.submissionInProgress = isSubmitting;
    submitButton.textContent = isSubmitting ? buttonText : defaultSubmitText;
    applyControlState();
  }

  function clearSelectedSlot() {
    state.selectedSlot = null;
    slotsContainer.replaceChildren();
    customerDetails.disabled = true;
    submitButton.disabled = true;
  }

  function formatTime(dateString) {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: BOOKING_TIME_ZONE,
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(dateString));
  }

  function formatSelectedSlot(dateString) {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: BOOKING_TIME_ZONE,
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(dateString));
  }

  function renderSlots(slots) {
    slotsContainer.replaceChildren();
    slots.forEach((slot, index) => {
      const wrapper = document.createElement('div');
      const input = document.createElement('input');
      const label = document.createElement('label');
      const inputId = `booking-slot-${index}`;
      wrapper.className = 'booking-slot-option';
      input.className = 'booking-slot-input';
      input.type = 'radio';
      input.name = 'bookingSlot';
      input.id = inputId;
      input.value = slot.start;
      label.className = 'booking-slot-label';
      label.htmlFor = inputId;
      label.textContent = `${formatTime(slot.start)} – ${formatTime(slot.end)}`;
      input.addEventListener('change', () => {
        if (!input.checked || state.reservationId) return;
        state.selectedSlot = slot;
        state.paymentRetryAvailable = false;
        setBookingMessage('success', `Seleccionaste el ${formatSelectedSlot(slot.start)}.`);
        applyControlState();
      });
      wrapper.append(input, label);
      slotsContainer.append(wrapper);
    });
  }

  async function loadAvailability(date) {
    state.availabilityController?.abort();
    const controller = new AbortController();
    state.availabilityController = controller;
    clearSelectedSlot();
    setBookingMessage('', '');
    if (!date || date < dateMinimum || date > dateMaximum) {
      setAvailabilityState('error', 'Selecciona una fecha dentro de los próximos 30 días.');
      return;
    }
    if (isWeekend(date)) {
      setAvailabilityState('error', 'Las consultas se realizan de lunes a viernes. Selecciona otro día.');
      return;
    }

    setAvailabilityState('loading', 'Consultando horarios disponibles…');
    dateInput.setAttribute('aria-busy', 'true');
    try {
      const slots = await fetchAvailability(date, controller.signal);
      if (controller.signal.aborted) return;
      if (slots.length === 0) {
        setAvailabilityState('empty', 'No hay horarios disponibles para esta fecha. Selecciona otro día.');
        return;
      }
      renderSlots(slots);
      setAvailabilityState('ready', 'Selecciona uno de los horarios disponibles.');
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return;
      setAvailabilityState('error', 'No pudimos consultar los horarios. Intenta nuevamente.');
    } finally {
      if (state.availabilityController === controller) {
        state.availabilityController = null;
        dateInput.removeAttribute('aria-busy');
      }
    }
  }

  function getReservationPayload() {
    if (!state.selectedSlot) return null;
    return {
      customerName: nameInput.value.trim(),
      customerEmail: emailInput.value.trim(),
      customerPhone: phoneInput.value.trim(),
      practiceArea: practiceAreaInput.value,
      startAt: state.selectedSlot.start,
    };
  }

  const fingerprintPayload = payload => JSON.stringify(payload);

  function getRateLimitMessage(retryAfter) {
    if (!retryAfter) {
      return 'Se han realizado varios intentos recientemente. Espera unos minutos antes de volver a intentarlo.';
    }
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    return `Se han realizado varios intentos recientemente. Intenta nuevamente en aproximadamente ${minutes} minutos.`;
  }

  async function handleReservationFailure(error) {
    setSubmitting(false);
    if (error instanceof BookingApiError && error.status === 409 && error.code === 'slot_unavailable') {
      clearSelectedSlot();
      await loadAvailability(dateInput.value);
      setBookingMessage('error', 'Este horario acaba de dejar de estar disponible. Elige otro horario.', true);
      return;
    }
    if (error instanceof BookingApiError && error.status === 429) {
      setBookingMessage('error', getRateLimitMessage(error.retryAfter), true);
      return;
    }
    if (error instanceof BookingApiError && error.status === 400) {
      setBookingMessage('error', 'Revisa los datos ingresados e intenta nuevamente.', true);
      return;
    }
    setBookingMessage('error', 'No pudimos crear la reserva en este momento. Intenta nuevamente.', true);
  }

  async function handlePaymentStartFailure(error) {
    const classification = classifyPaymentStartFailure(error);
    applyPaymentFailureState(state, classification);
    setSubmitting(false);

    if (classification === 'reservation_ended') {
      clearSelectedSlot();
      await loadAvailability(dateInput.value);
      setBookingMessage(
        'error',
        'La reserva temporal venció o ya no está disponible. Selecciona nuevamente un horario.',
        true,
      );
      return;
    }

    if (classification === 'ambiguous') {
      setBookingMessage(
        'error',
        'No pudimos confirmar el estado del pago. No intentes pagar nuevamente por ahora. Si realizaste alguna acción en Flow, verifica antes de repetir el pago o contáctanos.',
        true,
      );
      return;
    }

    const message = error instanceof BookingApiError && error.code === 'payment_in_progress'
      ? 'El pago todavía se está preparando. Espera unos segundos y vuelve a intentarlo.'
      : 'Tu horario está reservado temporalmente, pero no pudimos iniciar el pago. Reintenta únicamente el inicio del pago.';
    setBookingMessage(
      'error',
      message,
      true,
    );
  }

  async function startPayment() {
    const checkoutUrl = await createPayment(state.reservationId);
    setBookingMessage('success', 'Pago preparado. Te redirigiremos a Flow para completar la reserva.');
    window.location.assign(checkoutUrl);
  }

  async function submitReservation(event) {
    event.preventDefault();
    if (!acquireSubmissionLock(state)) return;
    if (!state.selectedSlot || !form.reportValidity()) {
      setSubmitting(false);
      setBookingMessage('error', 'Selecciona un horario y completa todos los datos requeridos.', true);
      return;
    }

    const payload = getReservationPayload();
    state.paymentRetryAvailable = false;
    setSubmitting(true, 'Reservando horario…');
    setBookingMessage('info', 'Estamos reservando temporalmente este horario. No cierres esta página.');
    try {
      state.reservationId = await createReservation(payload);
      state.reservationFingerprint = fingerprintPayload(payload);
    } catch (error) {
      state.reservationId = null;
      state.reservationFingerprint = null;
      await handleReservationFailure(error);
      return;
    }

    setSubmitting(true, 'Iniciando pago…');
    setBookingMessage('success', 'Tu horario quedó reservado por 10 minutos. Estamos iniciando el pago seguro con Flow…');
    try {
      await startPayment();
    } catch (error) {
      await handlePaymentStartFailure(error);
    }
  }

  async function retryPayment() {
    if (!state.reservationId || !acquireSubmissionLock(state)) return;
    const currentPayload = getReservationPayload();
    if (!currentPayload || fingerprintPayload(currentPayload) !== state.reservationFingerprint) {
      state.reservationId = null;
      state.reservationFingerprint = null;
      state.paymentRetryAvailable = false;
      setSubmitting(false);
      setBookingMessage('error', 'Los datos cambiaron. Selecciona nuevamente el horario para crear una reserva distinta.', true);
      return;
    }

    state.paymentRetryAvailable = false;
    setSubmitting(true, 'Iniciando pago…');
    setBookingMessage('info', 'Estamos reintentando únicamente el inicio del pago para tu reserva existente.');
    try {
      await startPayment();
    } catch (error) {
      await handlePaymentStartFailure(error);
    }
  }

  document.querySelectorAll('[data-booking-cta]').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      bookingSection.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      bookingTitle.focus({ preventScroll: true });
      window.history.replaceState(null, '', '#reserva');
    });
  });
  dateInput.addEventListener('change', () => {
    if (!state.reservationId) loadAvailability(dateInput.value);
  });
  form.addEventListener('submit', submitReservation);
  retryButton.addEventListener('click', retryPayment);
  applyControlState();
}

function initializePage() {
  if (window.lucide) window.lucide.createIcons();
  initializeMobileMenu();
  initializeBooking();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BookingApiError,
    acquireSubmissionLock,
    applyPaymentFailureState,
    addCalendarDays,
    classifyPaymentStartFailure,
    createPayment,
    createReservation,
    fetchAvailability,
    getSantiagoDateString,
    isWeekend,
    validateCheckoutUrl,
  };
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initializePage);
}
