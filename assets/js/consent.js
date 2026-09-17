(function initializeAdvertisingConsent() {
  'use strict';

  const STORAGE_KEY = 'sincro_ads_consent_v1';
  const GRANTED = 'granted';
  const DENIED = 'denied';
  const BANNER_ID = 'advertising-consent-banner';
  const consentTypes = [
    'ad_storage',
    'analytics_storage',
    'ad_user_data',
    'ad_personalization',
  ];

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };

  function buildConsentState(value) {
    return Object.fromEntries(consentTypes.map(type => [type, value]));
  }

  function readStoredPreference() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return value === GRANTED || value === DENIED ? value : null;
    } catch {
      return null;
    }
  }

  function storePreference(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Consent still applies to the current page if storage is unavailable.
    }
  }

  window.gtag('consent', 'default', buildConsentState(DENIED));

  let currentPreference = readStoredPreference();
  if (currentPreference) {
    window.gtag('consent', 'update', buildConsentState(currentPreference));
  }

  function removeBanner() {
    document.getElementById(BANNER_ID)?.remove();
  }

  function applyPreference(value) {
    currentPreference = value;
    storePreference(value);
    window.gtag('consent', 'update', buildConsentState(value));
    removeBanner();
  }

  function createButton(label, modifier, value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `consent-banner__button consent-banner__button--${modifier}`;
    button.textContent = label;
    button.addEventListener('click', () => applyPreference(value));
    return button;
  }

  function showBanner() {
    if (document.getElementById(BANNER_ID)) return;

    const banner = document.createElement('section');
    banner.id = BANNER_ID;
    banner.className = 'consent-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Preferencias de privacidad');

    const content = document.createElement('div');
    content.className = 'consent-banner__content';

    const copy = document.createElement('div');
    copy.className = 'consent-banner__copy';

    const title = document.createElement('p');
    title.className = 'consent-banner__title';
    title.textContent = 'Medición y privacidad';

    const description = document.createElement('p');
    description.className = 'consent-banner__description';
    description.append('Utilizamos tecnologías de Google para medir el rendimiento de nuestras campañas. Puedes aceptar o rechazar su uso. Consulta nuestra ');

    const privacyLink = document.createElement('a');
    privacyLink.href = 'privacidad.html';
    privacyLink.textContent = 'Política de Privacidad';
    description.append(privacyLink, '.');

    copy.append(title, description);

    const actions = document.createElement('div');
    actions.className = 'consent-banner__actions';
    actions.append(
      createButton('Rechazar', 'secondary', DENIED),
      createButton('Aceptar', 'primary', GRANTED),
    );

    content.append(copy, actions);
    banner.append(content);
    document.body.append(banner);
  }

  function openPreferences(event) {
    event?.preventDefault();
    showBanner();
  }

  function initializeInterface() {
    document.querySelectorAll('[data-consent-settings]').forEach(control => {
      control.addEventListener('click', openPreferences);
    });

    if (!currentPreference) showBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeInterface, { once: true });
  } else {
    initializeInterface();
  }

  window.SincroConsent = Object.freeze({ openPreferences });
})();
