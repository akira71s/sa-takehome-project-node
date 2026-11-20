// Load and validate .env first, before anything reads process.env
require('./config');

const path = require('node:path');
const express = require('express');
const { engine } = require('express-handlebars');
const { BOOKS, getBook } = require('./books');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

const app = express();
// Hosting platforms such as Render serve the app over HTTPS through a proxy,
// so the app itself receives plain HTTP. Trusting that one (1) proxy makes
// req.protocol 'https', which keeps the Stripe return_url on HTTPS.
app.set('trust proxy', 1);
// Available in every view as {{appName}}
app.locals.appName = 'BookStripes';

// View engine (Handlebars)
app.engine('hbs', engine({ defaultLayout: 'main', extname: '.hbs' }));
app.set('view engine', 'hbs');

app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /webhook
 * Receives payment events from Stripe, even if the customer never reaches the
 * confirmation page.
 *
 * Registered before express.json(): signature verification needs the raw body.
 * Responds 400 if the signature is invalid, or 503 if no signing secret is set.
 * @see https://docs.stripe.com/webhooks
 * @see https://docs.stripe.com/checkout/fulfillment
 */
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).send('Webhooks are not configured.');
  }

  let event;
  try {
    // https://docs.stripe.com/events/manage-webhook-endpoints?locale=en#signature-errors
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), secret);
  } catch (err) {
    console.warn(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send('Invalid signature.');
  }

  const session = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (session.payment_status !== 'unpaid') {
        // TODO (production): mark the order as paid in the database and start
        // fulfillment. Store event.id and skip events that were already
        // processed, since Stripe can deliver the same event more than once.
        console.log(`Payment confirmed for Checkout Session ${session.id}`);
      }
      break;
    case 'checkout.session.async_payment_failed':
      // TODO (production): mark the order as failed and notify the customer.
      console.warn(`Payment failed for Checkout Session ${session.id}`);
      break;
    default:
    // Other event types aren't used by this app.
  }

  res.json({ received: true });
});

app.use(express.json());

/**
 * GET /
 * Renders the store page listing all books from the catalog.
 */
app.get('/', (req, res) => {
  res.render('index', { books: BOOKS });
});

/**
 * GET /checkout?bookId=<id>
 * Renders the checkout page for one book, or an error if the ID is unknown.
 * The publishable key is passed to the page so the browser can initialize Stripe.js.
 */
app.get('/checkout', (req, res) => {
  const { bookId } = req.query;
  const book = getBook(bookId);

  if (!book) {
    console.warn(`Invalid bookId on checkout page: ${bookId}`);
    return res.status(404).render('checkout', { error: 'No book selected.' });
  }

  res.render('checkout', {
    bookId,
    title: book.title,
    amount: book.amount,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  });
});

/**
 * POST /create-checkout-session
 * Body: { bookId: string }
 *
 * Creates a Checkout Session (ui_mode: 'elements') for the given book and
 * returns its client secret, which the browser uses to mount the Payment Element.
 * The price always comes from the catalog on the server, never from the request.
 *
 * Responds 400 if the bookId is unknown, or 500 if Stripe returns an error.
 * @see https://docs.stripe.com/api/checkout/sessions/create
 */
app.post('/create-checkout-session', async (req, res) => {
  const { bookId } = req.body;
  const book = getBook(bookId);

  if (!book) {
    return res.status(400).json({ error: `Unknown bookId: ${bookId}` });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: 'elements',
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: book.amount,
            product_data: { name: book.title },
          },
          quantity: 1,
        },
      ],
      // Stripe replaces {CHECKOUT_SESSION_ID} with the real ID when redirecting
      return_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
      metadata: { bookId },
    });

    res.json({ clientSecret: session.client_secret });
  } catch (err) {
    console.error(`Could not create Checkout Session: ${err.message}`);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

/**
 * GET /success?session_id=<id>
 * Stripe redirects here after confirmation. Retrieves the session with its
 * PaymentIntent and renders the book, the amount charged, and the PaymentIntent ID.
 *
 * - No session ID, or an ID Stripe doesn't recognize: redirects to the store.
 * - Session still open (payment failed or was canceled): back to the book's checkout page.
 * - Payment still processing: asks the customer to refresh later. Each load
 *   reads the latest status from Stripe.
 * @see https://docs.stripe.com/api/checkout/sessions/retrieve
 */
app.get('/success', async (req, res) => {
  const sessionId = req.query.session_id;

  if (typeof sessionId !== 'string' || !sessionId) {
    console.warn('No session_id on /success. Redirecting to the home page.');
    return res.redirect('/');
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    });
  } catch (err) {
    console.warn(`Could not retrieve Checkout Session ${sessionId}: ${err.message}`);
    return res.redirect('/');
  }

  const { bookId } = session.metadata;
  if (session.status === 'open') {
    return res.redirect(`/checkout?bookId=${encodeURIComponent(bookId)}`);
  }

  const paid = session.payment_status === 'paid';
  const paymentIntent = session.payment_intent;
  res.render('success', {
    paid,
    // A delayed payment method (e.g. a bank debit) was declined after checkout.
    failed: !paid && paymentIntent?.status === 'requires_payment_method',
    bookId,
    amount: session.amount_total,
    paymentIntentId: paymentIntent?.id,
    book: getBook(bookId),
    email: session.customer_details?.email,
    date: new Date((paymentIntent?.created ?? session.created) * 1000).toLocaleDateString('en-US', {
      dateStyle: 'long',
    }),
  });
});

/**
 * Catch-all for unknown URLs. Shows the friendly error page instead of
 * Express's default "Cannot GET" page.
 */
app.use((req, res) => {
  res.status(404).render('error', { error: 'Page not found.' });
});

/**
 * Fallback error handler. Logs the error on the server and shows a friendly
 * page instead of Express's default page, which would expose a stack trace.
 *
 * Express recognizes an error handler by its four parameters, so `next` must
 * stay in the signature even though it isn't used.
 */
app.use((err, req, res, next) => {
  // Malformed JSON in a request body is the client's mistake, not a server error.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in the request body.' });
  }

  console.error(err);
  res.status(500).render('error', { error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
