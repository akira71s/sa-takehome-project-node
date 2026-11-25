// DOM elements
const form = document.getElementById('payment-form');
const submitButton = document.getElementById('submit');
const messageEl = document.getElementById('payment-message');
// Parent container wrapping both the email input and Payment Element
const checkoutCard = document.getElementById('checkout-card');
const themeButtons = document.querySelectorAll('#appearance-toggle [data-theme]');

// Prebuilt themes from the Stripe Elements Appearance API.
// @see https://docs.stripe.com/elements/appearance-api#theme
const APPEARANCES = Object.freeze({
  stripe: { theme: 'stripe' },
  flat: { theme: 'flat' },
  night: { theme: 'night' },
});

// Stripe setup. The server passes the publishable key and book ID through data- attributes.
const stripe = Stripe(form.dataset.publishableKey);

// Fetch the Checkout Session's client secret from server-side at /create-checkout-session
const clientSecretPromise = getClientSecret();
// If the server can't create a Checkout Session, tell the customer instead of
// leaving an empty form.
clientSecretPromise.catch((err) => {
  showError(err.message);
  submitButton.disabled = true;
});

const checkout = stripe.initCheckoutElementsSdk({
  clientSecret: clientSecretPromise, // a Promise is accepted
  elementsOptions: { appearance: APPEARANCES.stripe },
});

// https://docs.stripe.com/payments/payment-element?layout=accordion-with-radio-buttons
const paymentElement = checkout.createPaymentElement({
  layout: {
    // same as defualt
    type: 'accordion',
    // When you leave this undefined, Stripe renders the experience that it determines will have the best conversion.
    // https://docs.stripe.com/js/elements_object/create_payment_element#payment_element_create-options-layout-defaultCollapsed
    defaultCollapsed: false,
    // defalut - 'auto'
    // https://docs.stripe.com/js/elements_object/create_payment_element#payment_element_create-options-layout-radios
    radios: 'always',
    // only applicable when the type is 'accordion'
    // https://docs.stripe.com/js/elements_object/create_payment_element#payment_element_create-options-layout-spacedAccordionItems
    spacedAccordionItems: false,
  },
});
paymentElement.mount('#payment-element');
// https://docs.stripe.com/js/custom_checkout/checkout_object
// After calling initCheckoutElementsSdk, use loadActions() to access methods for reading and manipulating Checkout Sessions.
const actionsPromise = checkout.loadActions();

for (const button of themeButtons) {
  button.addEventListener('click', () => setTheme(button.dataset.theme));
}

form.addEventListener('submit', handleSubmit);

/**
 * Updates the Payment Element's theme via the Appearance API and adapts the
 * surrounding checkout card to match ('stripe', 'flat', or 'night').
 *
 * @param {string} theme - Key in `APPEARANCES`.
 * @returns {void}
 */
function setTheme(theme) {
  if (!Object.hasOwn(APPEARANCES, theme)) {
    return;
  }

  checkout.changeAppearance(APPEARANCES[theme]);
  // Update the style of the parent container wrapping both the email input and Payment Element
  checkoutCard.classList.toggle('checkout-card-flat', theme === 'flat');
  checkoutCard.classList.toggle('checkout-card-night', theme === 'night');

  for (const button of themeButtons) {
    const isSelected = button.dataset.theme === theme;
    button.classList.toggle('active', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  }
}

/**
 * Handles the payment form submission: sets the customer's email on the
 * Checkout Session, then confirms the payment. On success Stripe redirects
 * to the session's return_url, so this function only continues on error.
 *
 * @param {SubmitEvent} event
 * @returns {Promise<void>}
 */
async function handleSubmit(event) {
  event.preventDefault();
  setLoading(true);
  messageEl.textContent = '';

  const loadResult = await actionsPromise;
  if (loadResult.type === 'error') {
    return showError(loadResult.error.message);
  }
  // https://docs.stripe.com/js/custom_checkout/checkout_object
  const { actions } = loadResult;

  const email = document.getElementById('email').value;
  const emailResult = await actions.updateEmail(email);
  if (emailResult.type === 'error') {
    return showError(emailResult.error.message);
  }

  const confirmResult = await actions.confirm();
  if (confirmResult.type === 'error') {
    showError(confirmResult.error.message);
  }
}

/**
 * Asks the server to create a Checkout Session for this page's book.
 *
 * @returns {Promise<string>} The Checkout Session's client secret.
 * @throws {Error} If the request fails or the server responds with an error status.
 */
async function getClientSecret() {
  const response = await fetch('/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId: form.dataset.bookId }),
  });

  if (!response.ok) {
    throw new Error('Could not start checkout. Please refresh the page and try again.');
  }

  const data = await response.json();
  return data.clientSecret;
}

/**
 * Shows an error message below the payment form and re-enables the Pay button.
 *
 * @param {string} message
 * @returns {void}
 */
function showError(message) {
  messageEl.textContent = message;
  setLoading(false);
}

/**
 * Disables the Pay button while a payment is in progress to prevent double submission.
 *
 * @param {boolean} isLoading
 * @returns {void}
 */
function setLoading(isLoading) {
  submitButton.disabled = isLoading;
}
