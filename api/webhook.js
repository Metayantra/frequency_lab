// ── Lee el body RAW (necesario para verificar firma de Stripe) ─
const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

// ── Guarda en Upstash Redis via REST API ──────────────────────
const redisSet = async (key, value) => {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
};

// ── Envía evento a Klaviyo ────────────────────────────────────
const klaviyoTrack = async (email, eventName, props = {}) => {
  const apiKey = process.env.KLAVIYO_API_KEY;

  // 1. Crear/actualizar perfil
  await fetch("https://a.klaviyo.com/api/profiles/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: "2023-12-15",
    },
    body: JSON.stringify({
      data: {
        type: "profile",
        attributes: { email, properties: { source: "Frequency Lab", ...props } },
      },
    }),
  });

  // 2. Disparar evento (activa el flow de bienvenida en Klaviyo)
  await fetch("https://a.klaviyo.com/api/events/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: "2023-12-15",
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          profile: { data: { type: "profile", attributes: { email } } },
          metric: { data: { type: "metric", attributes: { name: eventName } } },
          properties: props,
          time: new Date().toISOString(),
        },
      },
    }),
  });
};

// ── Handler principal ─────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  // ── Verificar firma de Stripe ─────────────────────────────
  let event;
  try {
    // Verificación manual de firma (sin SDK de Stripe)
    const crypto = await import("crypto");
    const [, timestampPart, , v1Part] = sig.split(/[=,]/);
    const timestamp = timestampPart;
    const v1 = v1Part;
    const payload = `${timestamp}.${rawBody.toString()}`;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    if (expected !== v1) {
      console.error("Firma inválida");
      return res.status(400).json({ error: "Invalid signature" });
    }
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    console.error("Error verificando webhook:", err);
    return res.status(400).json({ error: "Webhook error" });
  }

  // ── Procesar eventos ──────────────────────────────────────
  try {
    const obj = event.data?.object;
    let email = null;

    if (event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated") {
      // Obtener email del customer
      const custRes = await fetch(
        `https://api.stripe.com/v1/customers/${obj.customer}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          },
        }
      );
      const cust = await custRes.json();
      email = cust.email;

      if (email && obj.status === "active" || obj.status === "trialing") {
        const subData = {
          active: true,
          status: obj.status,
          customerId: obj.customer,
          subscriptionId: obj.id,
          trialEnd: obj.trial_end
            ? obj.trial_end * 1000
            : Date.now() + 90 * 24 * 60 * 60 * 1000,
          activatedAt: Date.now(),
        };

        // Guardar en Redis
        await redisSet(`sub:${email}`, subData);

        // Klaviyo — bienvenida (activa tu flow en Klaviyo)
        await klaviyoTrack(email, "Frequency Lab Activado", {
          plan: "Trial 90 días",
          precio: "$199 MXN/mes",
          status: obj.status,
        });

        console.log(`✅ Acceso activado para: ${email}`);
      }
    }

    if (event.type === "invoice.payment_succeeded") {
      const custRes = await fetch(
        `https://api.stripe.com/v1/customers/${obj.customer}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          },
        }
      );
      const cust = await custRes.json();
      email = cust.email;

      if (email) {
        await redisSet(`sub:${email}`, {
          active: true,
          status: "active",
          customerId: obj.customer,
          paidAt: Date.now(),
        });

        await klaviyoTrack(email, "Frequency Lab Pago Recibido", {
          amount: `${obj.amount_paid / 100} MXN`,
        });

        console.log(`💰 Pago recibido de: ${email}`);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Error procesando evento:", err);
    return res.status(500).json({ error: "Processing error" });
  }
}
